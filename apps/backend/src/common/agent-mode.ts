/** HUMAN waits for a person. AUTO lets the background agents send the change. */
export function agentActsAlone(mode: string | null | undefined): boolean {
  return mode === 'AUTO';
}
