/** Substitute the home dir prefix with ~ (no path truncation; see PathLabel). */
export function displayCwd(cwd: string, homeDir?: string): string {
  return (homeDir && cwd.startsWith(homeDir)) ? "~" + cwd.slice(homeDir.length) : cwd;
}
