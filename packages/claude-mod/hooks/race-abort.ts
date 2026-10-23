type Raced<T> = { aborted: true } | { aborted: false; value: T }

// $.http.fetch takes no signal, so an abort can only stop our wait; the Supervisor ends the request within its 30 s cap.
export function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<Raced<T>> {
  if (signal.aborted) return Promise.resolve({ aborted: true })
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve({ aborted: true })
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve({ aborted: false, value })
      },
      err => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}
