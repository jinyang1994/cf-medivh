export function maskSecret(secret: string): string {
  if (!secret) return '';
  const characters = Array.from(secret);
  return characters.length > 8
    ? `${characters.slice(0, 4).join('')}••••••••${characters.slice(-4).join('')}`
    : '••••••••';
}
