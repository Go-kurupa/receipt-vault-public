import type { ToolRegistrar } from '../server';
import { getSnapshot, type Snapshot } from '../data';
import { registerSearch } from './search';
import { registerDetail } from './detail';
import { registerSummary } from './summary';
import { registerUnbooked } from './unbooked';
import { registerFreshness } from './freshness';

export function readRegistrars(get: () => Promise<Snapshot>): readonly ToolRegistrar[] {
  return [registerSearch(get), registerDetail(get), registerSummary(get), registerUnbooked(get), registerFreshness(get)];
}
export const READ_REGISTRARS = readRegistrars(getSnapshot);
