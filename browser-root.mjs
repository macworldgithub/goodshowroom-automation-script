import { RunnerError } from './backend-client.mjs';

export function browserRoot(page, frame) {
  if (!frame) return page;
  if (frame.startsWith('name:')) {
    const matches = page.frames().filter(item => item.name() === frame.slice(5));
    if (matches.length !== 1) throw new RunnerError('SOURCE_FRAME_NOT_UNIQUE');
    return matches[0];
  }
  return page.frameLocator(frame);
}
