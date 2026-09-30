/**
 * SkillsSection: install/import/update UI for workbench-managed skills.
 * Extracted from WorkbenchPanel.tsx in v0.8.0 (P4-26). Receives all data
 * and actions via props; fully self-contained.
 */
import { useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import clsx from 'clsx'
import type { WorkbenchSkillList, WorkbenchSkillSummary } from '../shared.ts'
import type { WorkbenchInjected } from './contract.ts'
import css from './WorkbenchPanel.module.css'

type SkillFormMode = 'inline' | 'git'

/** Inline-write install draft (name + description + Markdown body). */
interface SkillInlineDraft {
  name: string
  description: string
  content: string
}

/** Git-import draft (URL + optional ref + optional sub-path + target name). */
interface SkillGitDraft {
  url: string
  ref: string
  subPath: string
  name: string
}

function emptyInlineDraft(): SkillInlineDraft {
  return { name: '', description: '', content: '' }
}
function emptyGitDraft(): SkillGitDraft {
  return { url: '', ref: '', subPath: '', name: '' }
}

/**
 * Compose a SKILL.md body from the inline form: YAML frontmatter carrying
 * `name` + `description` (the two keys the dsh-skill-filesystem provider
 * reads) followed by the user's markdown body. Description is written on
 * one line and escaped minimally so the frontmatter parser accepts it.
 */
function composeInlineSkill(draft: SkillInlineDraft): string {
  const escapedDesc = draft.description.replace(/"/g, '\\"')
  const front = [
    '---',
    `name: ${draft.name}`,
    `description: "${escapedDesc}"`,
    '---',
    '',
  ].join('\n')
  return front + draft.content
}

/** Normalize any tail-of-path segment to a kebab-case skill identifier. */
function kebabize(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * Guess a kebab-case target name from a git URL + sub-path when the user
 * hasn't picked one yet. Walks sub-path segments from the leaf inward
 * skipping the reserved `SKILL.md` filename (that's the bundle contract,
 * not the skill's identity — the parent directory names it). Falls back
 * to the repo name (strip `.git` and any URL fragment).
 *
 * Fixes an earlier bug where `subPath: foo/SKILL.md` derived the name
 * "skill" (`SKILL.md` → strip .md → lowercase), then the flat-file branch
 * saved into `$DSH_HOME/skills/skill.md` instead of the real skill name.
 */
function suggestGitName(url: string, subPath: string): string {
  const segments = subPath.split('/').filter(s => s !== '' && s !== '.')
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i]
    // `SKILL.md` (case-insensitive) is the reserved bundle filename — its
    // parent directory is the meaningful identity, so skip past it.
    if (/^SKILL\.md$/i.test(seg)) continue
    const stripped = seg.replace(/\.md$/i, '')
    const kebab = kebabize(stripped)
    if (kebab !== '') return kebab
  }
  const trimmed = url.replace(/\.git$/i, '').replace(/[?#].*$/, '')
  const tail = trimmed.split(/[/:]/).filter(s => s !== '').pop() ?? ''
  return kebabize(tail)
}

/**
 * "工作台技能" section: rendered below the user-editable groups. Reads live
 * from ctx.skills via the Host `/skills` route, and lets the user install
 * new skill markdown files two ways:
 *
 *   - Inline: type a Markdown body; the Host wraps it in a YAML frontmatter
 *     carrying name + description and writes to $DSH_HOME/skills/<name>/.
 *   - Git import: clone a repo (shallow, http/https/ssh only) and copy the
 *     skill body at <subPath> into $DSH_HOME/skills/<name>/. Both bundle
 *     form (SKILL.md + assets) and flat form (a single *.md file) are
 *     accepted.
 *
 * Removal is only offered for skills the workbench itself owns (Host reports
 * `removable: true`), so project-scoped and bundled skills stay read-only.
 */
/**
 * Persistent success notice displayed at the top of the skills section after
 * a successful install / import. Persists until the user dismisses it (✕)
 * or hits "刷新" — the previous transient banner disappeared with the form
 * before the user could read the `writtenTo` path.
 *
 * `installed` is the primary display: single-item for bundle/flat imports,
 * multi-item for batch imports (a repo with several `<child>/SKILL.md`).
 */
interface SkillNotice {
  installed: string[]
  skipped?: Array<{ name: string; reason: string }>
  writtenTo?: string
  gitOutput?: string
  /** Set by the per-skill update flow when the source head was unchanged. */
  unchanged?: boolean
  /** Skill name for the unchanged notice. */
  unchangedName?: string
  sha?: string
}

export function SkillsSection(props: {
  skills: WorkbenchSkillList | null
  skillsLoading: boolean
  /** Panel search draft — reused to filter skill names/descriptions inline. */
  query: string
  installSkill: WorkbenchInjected['installSkill']
  importSkill: WorkbenchInjected['importSkill']
  updateSkill: WorkbenchInjected['updateSkill']
  onUse: (name: string) => void
  onRemove: (name: string) => void
  onReload: () => void
}) {
  const { skills, skillsLoading, query, installSkill, importSkill, updateSkill, onUse, onRemove, onReload } = props
  const [showForm, setShowForm] = useState(false)
  const [mode, setMode] = useState<SkillFormMode>('inline')
  const [inlineDraft, setInlineDraft] = useState<SkillInlineDraft>(emptyInlineDraft)
  const [gitDraft, setGitDraft] = useState<SkillGitDraft>(emptyGitDraft)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<SkillNotice | null>(null)
  /** Name of the skill currently running 检查更新 (P3-21). */
  const [updatingSkill, setUpdatingSkill] = useState<string | null>(null)

  const filtered = (skills?.skills ?? []).filter(s =>
    query === ''
    || s.name.toLowerCase().includes(query)
    || s.description.toLowerCase().includes(query))

  // How many of the just-installed skills are already visible in the current
  // catalog. Displayed on the success notice so the user can tell at a
  // glance whether dsh-skill-filesystem noticed the writes, or whether they
  // need to hit "刷新" (or wait for chokidar to invalidate).
  const catalogNames = new Set((skills?.skills ?? []).map(s => s.name))
  const noticedCount = notice === null
    ? 0
    : notice.installed.filter(name => catalogNames.has(name)).length
  const allNoticedInCatalog = notice !== null && noticedCount === notice.installed.length

  /** Per-skill "检查更新" (roadmap P3-21): re-clone the origin, apply changes. */
  const submitSkillUpdate = async (name: string): Promise<void> => {
    setUpdatingSkill(name)
    setError(null)
    try {
      const result = await updateSkill(name)
      if (result.changed === true) {
        setNotice({
          installed: result.installed !== undefined && result.installed.length > 0 ? result.installed : [name],
          ...(result.sha !== undefined ? { sha: result.sha } : {}),
        })
      } else {
        setNotice({ installed: [], unchanged: true, unchangedName: name, ...(result.sha !== undefined ? { sha: result.sha } : {}) })
      }
      onReload()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setUpdatingSkill(null)
    }
  }

  // NOTE (review 2026-09-03): the in-panel SKILL.md editor (P3-23 prototype)
  // was removed on purpose — an accidental edit could silently corrupt an
  // installed skill, and delete + reinstall is the safer recovery for
  // ordinary users. The /skills/source route went with it.

  const submitInline = async (): Promise<void> => {
    const name = inlineDraft.name.trim()
    const content = inlineDraft.content.trim()
    if (name === '') { setError('技能名称不能为空'); return }
    if (content === '') { setError('技能正文不能为空'); return }
    setBusy(true)
    setError(null)
    try {
      const result = await installSkill({ name, content: composeInlineSkill(inlineDraft) })
      setInlineDraft(emptyInlineDraft())
      setShowForm(false)
      setNotice({ installed: [name], writtenTo: result.writtenTo })
      onReload()
    } catch (err) {
      // Keep the form open on failure so the user can retry without retyping.
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const submitGit = async (): Promise<void> => {
    const url = gitDraft.url.trim()
    if (url === '') { setError('Git 仓库地址不能为空'); return }
    const name = gitDraft.name.trim() !== '' ? gitDraft.name.trim() : suggestGitName(url, gitDraft.subPath)
    if (name === '') { setError('目标名称不能为空（无法从 URL 与子路径推断）'); return }
    setBusy(true)
    setError(null)
    try {
      const result = await importSkill({
        url,
        name,
        ...(gitDraft.subPath.trim() !== '' ? { subPath: gitDraft.subPath.trim() } : {}),
        ...(gitDraft.ref.trim() !== '' ? { ref: gitDraft.ref.trim() } : {}),
      })
      setGitDraft(emptyGitDraft())
      setShowForm(false)
      // Batch imports return an array of installed names; single-skill
      // imports return a one-element array. Either way `installed` is
      // authoritative — the user-typed `name` is ignored for batch.
      setNotice({
        installed: result.installed && result.installed.length > 0 ? result.installed : [name],
        ...(result.skipped !== undefined && result.skipped.length > 0 ? { skipped: result.skipped } : {}),
        ...(result.writtenTo !== undefined ? { writtenTo: result.writtenTo } : {}),
        ...(result.output !== undefined && result.output !== '' ? { gitOutput: result.output } : {}),
      })
      onReload()
    } catch (err) {
      // Preserve the git draft so the user can adjust one field and retry.
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={css.skills} aria-label="工作台技能">
      <div className={css.skillsHead}>
        <h2 className={css.groupTitle}>工作台技能</h2>
        <span className={css.skillsTools}>
          {skillsLoading && <span className={css.skillsMeta}>加载中…</span>}
          {skills?.complete === false && !skillsLoading && (
            <span className={css.skillsMeta} title="部分技能提供者未完成发现">部分</span>
          )}
          <Button
            size="sm"
            variant={showForm ? 'primary' : 'outline'}
            onClick={() => { setShowForm(v => !v); setError(null) }}
            disabled={busy}
          >
            {showForm ? '取消' : '+ 新建技能'}
          </Button>
        </span>
      </div>

      {showForm && (
        <div className={css.skillsForm}>
          <div className={css.skillsTabs} role="tablist">
            <Button
              size="sm"
              variant={mode === 'inline' ? 'primary' : 'outline'}
              onClick={() => { setMode('inline'); setError(null) }}
              disabled={busy}
              role="tab"
              aria-selected={mode === 'inline'}
            >
              手写正文
            </Button>
            <Button
              size="sm"
              variant={mode === 'git' ? 'primary' : 'outline'}
              onClick={() => { setMode('git'); setError(null) }}
              disabled={busy}
              role="tab"
              aria-selected={mode === 'git'}
            >
              从 Git 仓库导入
            </Button>
          </div>

          {mode === 'inline' && (
            <>
              <Input
                placeholder="kebab-case 名称（如 whaletv-build-mp）"
                value={inlineDraft.name}
                onChange={event => { setInlineDraft(d => ({ ...d, name: event.target.value })) }}
              />
              <Input
                placeholder="一行描述（模型看得到的路由提示）"
                value={inlineDraft.description}
                onChange={event => { setInlineDraft(d => ({ ...d, description: event.target.value })) }}
              />
              <textarea
                className={css.skillsTextarea}
                placeholder={'技能正文（Markdown）\n\n可以粘贴现有 SKILL.md 的正文；工作台会自动加上 name + description 的 YAML frontmatter。'}
                value={inlineDraft.content}
                onChange={event => { setInlineDraft(d => ({ ...d, content: event.target.value })) }}
                rows={10}
              />
            </>
          )}

          {mode === 'git' && (
            <>
              <Input
                placeholder="Git 仓库地址（如 https://github.com/user/skills.git 或 git@github.com:user/skills.git）"
                value={gitDraft.url}
                onChange={event => { setGitDraft(d => ({ ...d, url: event.target.value })) }}
              />
              <div className={css.formRow}>
                <Input
                  placeholder="分支 / tag / 提交 SHA（可选，默认默认分支）"
                  value={gitDraft.ref}
                  onChange={event => { setGitDraft(d => ({ ...d, ref: event.target.value })) }}
                />
                <Input
                  placeholder="仓库内子路径（可选，如 commit-message 或 skills/foo.md）"
                  value={gitDraft.subPath}
                  onChange={event => { setGitDraft(d => ({ ...d, subPath: event.target.value })) }}
                />
              </div>
              <Input
                placeholder={`目标名称（可选，留空自动推断为「${suggestGitName(gitDraft.url, gitDraft.subPath) || 'skill-name'}」）`}
                value={gitDraft.name}
                onChange={event => { setGitDraft(d => ({ ...d, name: event.target.value })) }}
              />
              <p className={css.skillsHelp}>
                子路径可以指向：<br/>
                &nbsp;• 一个 <strong>包含 SKILL.md 的目录</strong>（bundle，assets/refs 一起复制）<br/>
                &nbsp;• 一个 <strong>SKILL.md 文件</strong>（自动上溯一级作为 bundle）<br/>
                &nbsp;• 一个 <strong>flat 的 *.md 文件</strong>（单文件安装）<br/>
                &nbsp;• 一个 <strong>目录，下面每个子目录各有 SKILL.md</strong>（<em>批量安装</em>，"目标名称"会被忽略，每个子目录用自己名字挂载）<br/>
                留空 = 仓库根目录同上判定。仅接受 http(s) / ssh 协议。
              </p>
              <p className={css.skillsHelp}>
                <strong>私有仓库</strong>：工作台子进程没有交互终端，无法弹凭据框。请任选一种：
                （a）先在命令行手动 <code>git clone</code> 一次同一仓库，让 Git Credential Manager 缓存凭据；
                （b）改用 SSH 地址（<code>git@host:owner/repo.git</code>）+ 配置好的 SSH key；
                （c）临时用 <code>https://&lt;user&gt;:&lt;token&gt;@host/...</code> 格式内嵌 PAT。
              </p>
            </>
          )}

          {error !== null && <p className={css.skillsError} role="alert">{error}</p>}
          <div className={css.formActions}>
            <Button
              size="sm"
              variant="primary"
              onClick={() => { void (mode === 'inline' ? submitInline() : submitGit()) }}
              disabled={busy}
            >
              {busy ? (mode === 'git' ? '克隆中…' : '安装中…') : (mode === 'git' ? '克隆并安装' : '安装到 $DSH_HOME/skills')}
            </Button>
          </div>
        </div>
      )}

      {notice !== null && (
        <div className={css.skillsSuccess} role="status">
          <div className={css.skillsSuccessHead}>
            <p className={css.skillsSuccessTitle}>
              ✓ {notice.unchanged === true
                ? `「${notice.unchangedName}」已是最新${notice.sha !== undefined ? `（${notice.sha}）` : ''}`
                : notice.installed.length === 1
                  ? `技能「${notice.installed[0]}」已${allNoticedInCatalog ? '安装并挂载' : '写入磁盘'}`
                  : `已批量导入 ${notice.installed.length} 个技能${allNoticedInCatalog ? '，全部已挂载' : `（其中 ${noticedCount} 个已挂载）`}`}
            </p>
            <Button
              size="sm"
              className={css.dismiss}
              onClick={() => { setNotice(null) }}
              aria-label="关闭提示"
            >
              ✕
            </Button>
          </div>
          {notice.installed.length > 1 && (
            <p className={css.skillsSuccessDetail}>
              {notice.installed.map(n => (
                <code key={n} style={{ marginRight: 6 }}>{n}</code>
              ))}
            </p>
          )}
          {notice.writtenTo !== undefined && (
            <p className={css.skillsSuccessDetail}>
              {notice.installed.length === 1 ? '文件位置' : '安装到'}：<code>{notice.writtenTo}</code>
            </p>
          )}
          {notice.skipped !== undefined && notice.skipped.length > 0 && (
            <div className={css.skillsSuccessDetail}>
              以下条目被跳过：
              <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                {notice.skipped.map(s => (
                  <li key={s.name}><code>{s.name}</code> — {s.reason}</li>
                ))}
              </ul>
            </div>
          )}
          {!allNoticedInCatalog && (
            <p className={css.skillsSuccessDetail}>
              dsh 技能注册表还没抓到全部新增；点顶部「刷新」按钮或稍候几秒让 chokidar 触发 —— 如果仍然看不到，说明 dsh 里没挂 <code>dsh-skill-filesystem</code>（跑 <code>dsh --profile web --dump-config</code> 确认）。
            </p>
          )}
          {notice.gitOutput !== undefined && (
            <pre className={css.skillsOutput}>{notice.gitOutput}</pre>
          )}
        </div>
      )}

      {skills?.ok === false && skills.error !== undefined && (
        <p className={css.skillsError} role="alert">技能列表读取失败：{skills.error}</p>
      )}

      {skills?.ok === true && filtered.length === 0 && !skillsLoading && notice === null && (
        <p className={css.hint}>
          {query === '' ? '当前没有可用的技能。点击「+ 新建技能」写入一份，或从 Git 仓库导入。' : '没有匹配的技能。'}
        </p>
      )}

      <div className={css.grid}>
        {filtered.map((skill: WorkbenchSkillSummary) => (
          <div key={`${skill.provider}:${skill.name}`} className={css.item}>
            <div className={css.itemHead}>
              <span className={css.itemTitle}>{skill.name}</span>
              <span className={css.badge} title={`来源：${skill.source}｜提供者：${skill.provider}`}>{skill.source}</span>
            </div>
            <p className={css.itemDesc}>{skill.description}</p>
            {skill.whenToUse !== undefined && skill.whenToUse !== '' && (
              <p className={css.itemDesc}><em>用途：</em>{skill.whenToUse}</p>
            )}
            {skill.origin !== undefined && (
              <p className={css.checkMeta} title={skill.origin.sourceUrl ?? '手写技能'}>
                来源：{skill.origin.sourceUrl ?? '手写'}
                {skill.origin.sha !== undefined ? ` @ ${skill.origin.sha}` : ''}
                {` · ${skill.origin.installedAt.slice(0, 10)}`}
              </p>
            )}
            <div className={css.itemActions}>
              <Button size="sm" variant="outline" onClick={() => { onUse(skill.name) }}>使用</Button>
              {skill.origin?.sourceUrl !== undefined && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => { void submitSkillUpdate(skill.name) }}
                  disabled={updatingSkill !== null}
                  title="重新克隆来源仓库并应用新提交"
                >
                  {updatingSkill === skill.name ? '检查中…' : '检查更新'}
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

