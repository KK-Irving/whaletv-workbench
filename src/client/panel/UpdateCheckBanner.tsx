/**
 * "检查更新" result banner (roadmap P1-8 / P1-10): the incoming commit list
 * plus apply / skip / dismiss actions. Rendered between the header and the
 * search row while a check result is on screen. Extracted in v0.8.16.
 */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkbenchUpdateCheckResult } from '../../shared.ts'
import css from '../WorkbenchPanel.module.css'

export function UpdateCheckBanner(props: {
  result: WorkbenchUpdateCheckResult
  disabled: boolean
  onUpdate: () => void
  onSkip: (sha: string) => void
  onDismiss: () => void
}) {
  const { result, disabled, onUpdate, onSkip, onDismiss } = props
  if (result.tarball === true) {
    return (
      <div className={css.checkBanner}>
        <div className={css.checkHead}>
          <span>
            {result.upToDate === true
              ? `已是最新（${result.installedVersion}）。`
              : `有新版本：${result.installedVersion} → ${result.latestVersion}。`}
          </span>
          <span className={css.spacer} />
          <Button size="sm" className={css.dismiss} onClick={onDismiss} aria-label="关闭检查结果">✕</Button>
        </div>
        {result.upToDate !== true && (
          <p className={css.checkMeta}>
            点「更新」在线安装新版本（pnpm add github 仓库最新提交）；完成后<b>重启 dsh</b> 生效。
          </p>
        )}
        <div className={css.checkActions}>
          {result.upToDate !== true && (
            <Button size="sm" variant="primary" onClick={onUpdate} disabled={disabled}>更新</Button>
          )}
        </div>
      </div>
    )
  }
  return (
    <div className={css.checkBanner}>
      <div className={css.checkHead}>
        <span>
          {result.skipped === true
            ? `远端有 ${result.behind} 个新提交；最新版本（${result.remoteHead}）已被你跳过。`
            : `远端（${result.upstream ?? 'upstream'}）有 ${result.behind} 个新提交。`}
        </span>
        <span className={css.spacer} />
        <Button size="sm" className={css.dismiss} onClick={onDismiss} aria-label="关闭检查结果">✕</Button>
      </div>
      <p className={css.checkMeta}>
        最新为 <code>{result.remoteHead}</code>；「更新」立即拉取，「跳过此版本」暂停提醒（远端再前进会重新提醒）。
      </p>
      {result.commits !== undefined && result.commits.length > 0 && (
        <ul className={css.checkList}>
          {result.commits.map(commit => (
            <li key={commit.sha} className={css.checkItem}>
              <span className={css.checkSha}>{commit.sha}</span>
              <span>{commit.subject}</span>
            </li>
          ))}
        </ul>
      )}
      <div className={css.checkActions}>
        <Button size="sm" variant="primary" onClick={onUpdate} disabled={disabled}>更新</Button>
        {result.remoteHead !== undefined && result.skipped !== true && (
          <Button size="sm" variant="outline" onClick={() => { onSkip(result.remoteHead!) }} disabled={disabled}>跳过此版本</Button>
        )}
      </div>
    </div>
  )
}
