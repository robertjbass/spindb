/**
 * Pure selection logic for the interactive version picker.
 *
 * The picker's choice list is derived from hostdb (newest major first), but the
 * preselected entry is spindb POLICY: `getEngineDefaults(engine).defaultVersion`.
 * Those two can disagree on purpose - MySQL recommends the `8.4` LTS line while
 * hostdb's newest is a `9.x` innovation release - so the newest entry keeps the
 * "latest" label while the preselection follows the configured default.
 *
 * Kept separate from `prompts.ts` so it can be unit tested without inquirer.
 */

export type MajorVersionMarkers = {
  // The newest major line offered for this engine (gets the "latest" label).
  isNewest: boolean
  // The engine's configured default line, shown only when it is NOT the newest
  // (otherwise "latest" already says it).
  isDefault: boolean
}

/**
 * Pick the major version line the picker should preselect.
 *
 * Returns the engine's configured default when it is actually selectable, and
 * otherwise falls back to the newest selectable line (the pre-existing
 * behavior). A prerelease-only line is never eligible: those are surfaced so a
 * user can opt in explicitly, never preselected.
 */
export function resolveDefaultMajorVersion(options: {
  // Selectable major lines, newest first, exactly as offered in the picker.
  selectableMajors: string[]
  // `defaultVersion` from config/engine-defaults.ts, when known.
  configuredDefault?: string
  // Lines that exist only as prereleases, which can never be the default.
  prereleaseMajors?: readonly string[]
}): string | undefined {
  const { selectableMajors, configuredDefault, prereleaseMajors = [] } = options

  const isEligible = (major: string): boolean =>
    selectableMajors.includes(major) && !prereleaseMajors.includes(major)

  if (configuredDefault && isEligible(configuredDefault)) {
    return configuredDefault
  }

  return selectableMajors.find((major) => !prereleaseMajors.includes(major))
}

/**
 * Which labels a major-version entry earns.
 */
export function getMajorVersionMarkers(options: {
  major: string
  newestMajor?: string
  defaultMajor?: string
}): MajorVersionMarkers {
  const { major, newestMajor, defaultMajor } = options
  const isNewest = newestMajor !== undefined && major === newestMajor
  return {
    isNewest,
    isDefault:
      defaultMajor !== undefined && major === defaultMajor && !isNewest,
  }
}
