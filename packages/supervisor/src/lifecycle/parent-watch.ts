function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Reparenting to launchd and pid reuse are both caught by checking the pid and the live ppid together.
export function watchParent(intervalMs: number, onGone: () => void): () => void {
  const parentPid = process.ppid;
  const timer = setInterval(() => {
    if (process.ppid !== parentPid || !isAlive(parentPid)) {
      clearInterval(timer);
      onGone();
    }
  }, intervalMs);
  return () => clearInterval(timer);
}
