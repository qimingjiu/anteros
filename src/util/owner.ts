/**
 * Deployment-specific owner / host settings, read from the environment so no
 * personal data is hardcoded in the source.
 *   OWNER_DISPLAY_NAME  how personas refer to the owner in prompts (default 主人)
 *   HAREM_SSH_TARGET    user@host for the persona private-space box (unset = feature off)
 *   HAREM_SSH_KEY       private key path, relative to cwd (default data/harem_ed25519)
 *   HAREM_SSH_ROOT      remote root directory for persona rooms (default /srv/harem)
 */
export const OWNER_NAME = process.env.OWNER_DISPLAY_NAME?.trim() || "主人";
export const OWNER_NAME_EN = process.env.OWNER_DISPLAY_NAME_EN?.trim() || "your owner";
export const HAREM_SSH_TARGET = process.env.HAREM_SSH_TARGET?.trim() || "";
export const HAREM_SSH_KEY = process.env.HAREM_SSH_KEY?.trim() || "data/harem_ed25519";
export const HAREM_SSH_ROOT = (process.env.HAREM_SSH_ROOT?.trim() || "/srv/harem").replace(/\/+$/, "");
