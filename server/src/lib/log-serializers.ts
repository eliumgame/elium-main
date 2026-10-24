/**
 * Sérialiseur de requête pour le journal : jamais de query string. Le jeton d'accès du WebSocket
 * collab voyage dans l'URL (`?token=…`) ; sans ce filtre il serait écrit en clair à chaque connexion.
 */
export function serializeRequestForLog(req: {
  method?: string;
  url?: string;
  host?: string;
  ip?: string;
  socket?: { remotePort?: number };
}) {
  return {
    method: req.method,
    url: (req.url ?? "").split("?")[0],
    host: req.host,
    remoteAddress: req.ip,
    remotePort: req.socket?.remotePort,
  };
}
