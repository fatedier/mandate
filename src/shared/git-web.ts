/** The https address of a repository from its git remote, or null when the
 *  remote is not on a web host (a local path, an unknown scheme). */
export function remoteWebBase(gitRemote: string | null | undefined): string | null {
  const remote = gitRemote?.trim();
  if (!remote) return null;
  const strip = (p: string) => p.replace(/\/+$/, "").replace(/\.git$/, "");
  const scp = /^[\w.-]+@([\w.-]+):(?!\/)(.+)$/.exec(remote);
  if (scp) return `https://${scp[1]}/${strip(scp[2]!)}`;
  try {
    const url = new URL(remote);
    if (!["http:", "https:", "ssh:", "git:"].includes(url.protocol) || !url.hostname) return null;
    const path = strip(url.pathname.replace(/^\/+/, ""));
    // An http(s) remote's port is the web server's; an ssh or git port is not.
    const web = url.protocol === "http:" || url.protocol === "https:";
    const host = web && url.port ? `${url.hostname}:${url.port}` : url.hostname;
    return path ? `${web ? url.protocol : "https:"}//${host}/${path}` : null;
  } catch {
    return null;
  }
}
