import QRCode from "qrcode";

/** Render a QR code as a PNG data URL (used for verification / proof codes). */
export async function makeQrDataUrl(text: string): Promise<string> {
  return QRCode.toDataURL(text, {
    margin: 1,
    width: 320,
    errorCorrectionLevel: "M",
    color: { dark: "#0f172a", light: "#ffffff" },
  });
}
