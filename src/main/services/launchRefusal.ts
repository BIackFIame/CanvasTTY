/**
 * A launch or delegation rule refused the request. The message says why, in words an agent can act on (so it adapts
 * instead of retrying the same call), and never counts as a transient failure.
 */
export class LaunchRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaunchRefusal";
  }
}
