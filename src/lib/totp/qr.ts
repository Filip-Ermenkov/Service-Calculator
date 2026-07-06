import QRCode from 'qrcode'

/** Renders an `otpauth://` URI as a scannable QR code, returned as a data URL. */
export function generateQrCodeDataUrl(otpAuthUri: string): Promise<string> {
  return QRCode.toDataURL(otpAuthUri, { errorCorrectionLevel: 'M', margin: 1, width: 256 })
}
