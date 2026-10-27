/**
 * Reads the dynamic segment that follows `/<base>/` in a pathname.
 *
 * The static export only prerenders one placeholder page per dynamic route
 * (`chat/_.html`, `draw/_.html`) that the backend serves for every real id, so
 * route params would hydrate as the placeholder. The real id always comes from
 * the URL instead, which behaves the same under `next dev`.
 */
export function routeParam(pathname: string | null | undefined, base: string): string | null {
  if (!pathname) return null;
  const prefix = `/${base}/`;
  if (!pathname.startsWith(prefix)) return null;
  const segment = pathname.slice(prefix.length).split("/")[0];
  if (!segment) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
