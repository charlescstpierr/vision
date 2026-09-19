import type { PendingPairing } from '@vizion/shared';

type Props = {
  pending: PendingPairing | null;
  /** Current port, so the prompt can say when pairing would change it. */
  currentPort: number;
  onConfirm: (pending: PendingPairing) => void;
  onDismiss: () => void;
};

/**
 * Confirmation step for a pairing the content script read off the local
 * server's `/pair` page. It exists because the payload comes from a web page:
 * naming the project directory lets the user recognise their own server before
 * the extension starts sending it page context.
 */
export default function PairingPrompt({ pending, currentPort, onConfirm, onDismiss }: Props) {
  if (!pending) return null;

  return (
    <div
      style={{
        marginTop: 12,
        padding: '10px 12px',
        border: '1px solid #b8d4bc',
        background: '#f1f8f2',
        borderRadius: 6,
      }}
    >
      <strong style={{ fontSize: 13 }}>Appairer Vizion ?</strong>
      <p style={{ fontSize: 12, color: '#333', margin: '6px 0 0' }}>
        Un serveur local propose de s'appairer :
      </p>
      <p style={{ fontSize: 12, margin: '4px 0 0', wordBreak: 'break-all' }}>
        <code>{pending.cwd}</code>
        <br />
        port {pending.port}
        {pending.port !== currentPort && ` (remplace ${currentPort})`} · version {pending.version}
      </p>
      <p style={{ fontSize: 11, color: '#666', margin: '6px 0 0' }}>
        Confirme seulement si c'est bien le projet où tu viens de lancer <code>vizion</code>.
      </p>
      <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
        <button onClick={() => onConfirm(pending)}>Appairer</button>
        <button onClick={onDismiss}>Ignorer</button>
      </div>
    </div>
  );
}
