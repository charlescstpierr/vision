import crypto from 'node:crypto';
import { PAIRING_DONE_ATTRIBUTE, PAIRING_PAYLOAD_ELEMENT_ID, type PairingPayload } from '@vizion/shared';

/** A fresh, unguessable pairing code. */
export function createPairingCode(): string {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Embeds a JSON value in an HTML `<script type="application/json">` body.
 * `<` is escaped so no value -- however hostile -- can close the tag early and
 * inject markup; the escape is valid JSON, so `JSON.parse` still reads it back.
 */
export function escapeJsonForScriptTag(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/**
 * The page `GET /pair` serves. It carries the connection details for the
 * content script to pick up, and tells the user what to do next. It is plain
 * inline HTML with no external resources, so it renders the same offline and
 * cannot be tampered with in transit on loopback.
 */
export function renderPairingPage(payload: PairingPayload): string {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vizion — appairage</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 34rem; margin: 4rem auto; padding: 0 1.5rem; line-height: 1.5; }
  h1 { font-size: 1.25rem; margin-bottom: 0.25rem; }
  code { background: rgba(127, 127, 127, 0.18); padding: 0.1rem 0.35rem; border-radius: 4px; }
  .status { margin-top: 1.5rem; padding: 0.85rem 1rem; border-radius: 8px; border: 1px solid rgba(127, 127, 127, 0.35); }
  .waiting { display: block; }
  .done { display: none; }
  html[${PAIRING_DONE_ATTRIBUTE}] .waiting { display: none; }
  html[${PAIRING_DONE_ATTRIBUTE}] .done { display: block; }
</style>
</head>
<body>
<h1>Vizion — appairage</h1>
<p>Projet : <code>${escapeHtml(payload.cwd)}</code><br>Port : <code>${payload.port}</code></p>
<div class="status">
  <p class="waiting">
    En attente de l'extension… Si rien ne se passe, vérifie que l'extension Vizion est installée,
    puis recharge cette page.
  </p>
  <p class="done">
    ✓ Détecté par l'extension. Ouvre le panneau latéral Vizion et confirme l'appairage.
  </p>
</div>
<script type="application/json" id="${PAIRING_PAYLOAD_ELEMENT_ID}">${escapeJsonForScriptTag(payload)}</script>
</body>
</html>
`;
}

/** Escapes the characters that would otherwise be read as markup in text content. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
