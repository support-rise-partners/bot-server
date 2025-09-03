// roles.js

// Listen von E-Mail-Adressen nach Rollen
export const roles = {
  admin: [
    "andrii.panchenko@rise-partners.de",
    "jan.eversmann@rise-partners.de",
    "support@rise-partners.de"
  ]
};

/**
 * Prüft, ob die angegebene E-Mail-Adresse ein Administrator ist.
 * @param {string} email - Zu prüfende E-Mail-Adresse
 * @returns {boolean} true, wenn die E-Mail-Adresse in der Admin-Liste enthalten ist
 */
export function isAdmin(email) {
  if (!email || typeof email !== "string") return false;
  return roles.admin.includes(email.toLowerCase());
}
