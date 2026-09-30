/**
 * dsh-native replacement for window.confirm / window.alert: themed, escaped
 * by the modal layer, and it returns focus to the invoking control (the
 * native dialogs block the page and ignore the product's own styling).
 * Extracted in the v0.8.16 split.
 */
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import css from '../WorkbenchPanel.module.css'

/**
 * One in-panel confirmation request. `cancelLabel: null` renders an
 * information-only dialog (the old window.alert sites).
 */
export interface ConfirmRequest {
  title: string
  description: string
  confirmLabel: string
  cancelLabel: string | null
  /** Destructive action: confirms with the danger tone. */
  danger?: boolean
  onConfirm: () => void
}

export function ConfirmDialog({ request, onClose }: { request: ConfirmRequest | null; onClose: () => void }) {
  if (request === null) return null
  return (
    <Modal
      open
      onClose={onClose}
      title={request.title}
      description={request.description}
      closeLabel="关闭"
      footer={(
        <>
          {request.cancelLabel !== null && (
            <Button size="sm" variant="outline" onClick={onClose}>{request.cancelLabel}</Button>
          )}
          <Button
            size="sm"
            variant="primary"
            className={request.danger === true ? css.danger : undefined}
            data-modal-autofocus
            onClick={() => { onClose(); request.onConfirm() }}
          >
            {request.confirmLabel}
          </Button>
        </>
      )}
    />
  )
}
