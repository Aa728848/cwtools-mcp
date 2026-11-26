/**
 * Pure ship-design parser + format-preserving edit builder, shared by the VS
 * Code Host and the DSH native Ship Design view. Transport-neutral: no vscode,
 * fs, path or DOM, so the browser client and the Host consume one implementation.
 *
 * Host-only concerns (resource bytes, screenshots and disk transactions) stay in
 * the Host layer; catalog projection, stats and write-back share this core.
 */
export * from './shipDesignProtocol';
export * from './definitionNodes';
export * from './designDocument';
export * from './shipIconDefinitions';
export * from './targetWeightExtract';
export * from './definitions';
export * from './slots';
export * from './stats';
