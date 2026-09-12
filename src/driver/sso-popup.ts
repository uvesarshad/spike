/* A9 (P0) — popup sign-in guard.
 *
 * "Sign in with Google/Microsoft/GitHub/Apple" is, in practice, always a
 * `window.open` popup. A transport that can only see the one tab it was given
 * cannot look at that popup, click in it, or switch to it — so clicking the
 * button burns steps, leaves the run staring at an unchanged page, and ends in
 * a confusing "couldn't finish".
 *
 * The real fix is adopting the popup as a switchable tab, which the CDP
 * transport now does (see CdpBrowser.takeNewTabs / adoptPageTarget). This
 * module is the honest fallback for transports that can't: recognise the
 * button BEFORE clicking it and end with one plain sentence telling the user
 * the thing that actually works — sign in on the tab yourself, then run.
 *
 * Capability is probed by the presence of BrowserPort.takeNewTabs, so a
 * transport that grows popup support turns this guard off simply by
 * implementing it.
 */

/** The single user-facing sentence. Plain English, no jargon, and it names the
 * one action that gets the user unstuck. */
export const SSO_POPUP_UNSUPPORTED_REASON =
  "Sign-in popups aren't supported yet — log in on this tab first, then run again";

/** Accessible names that mean "this opens a third-party sign-in popup".
 * Deliberately narrow: it must not swallow an ordinary in-page login button
 * (an email/password form still works fine and must keep working). */
const SSO_BUTTON_RE = /\b(sign[- ]?in|sign[- ]?up|log[- ]?in|continue|connect)\s+with\s+(google|microsoft|github|apple)\b/i;

/** True when `name` reads as a third-party sign-in button. */
export function isSsoPopupButtonName(name: string | undefined | null): boolean {
  if (!name) return false;
  return SSO_BUTTON_RE.test(name);
}

/** The guard the driver applies before executing a click.
 *
 * @param actionType   the action about to run — only a click opens a popup.
 * @param targetName   the resolved accessible name of the clicked node.
 * @param canAdoptPopups whether this transport can adopt a popup as a tab.
 * @returns the plain reason to end on, or null to proceed normally.
 */
export function detectSsoPopupClick(
  actionType: string,
  targetName: string | undefined,
  canAdoptPopups: boolean,
): string | null {
  if (canAdoptPopups) return null;
  if (actionType !== 'click') return null;
  return isSsoPopupButtonName(targetName) ? SSO_POPUP_UNSUPPORTED_REASON : null;
}
