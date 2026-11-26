/**
 * Pure ship-design data contract shared by VS Code, DSH and the native views.
 * Transport envelopes and runtime message validation remain in the VS Code Host.
 */

export interface ShipDesignSourceRangeData {
    start: number;
    end: number;
    startLine: number;
    endLine: number;
}

export interface ShipDesignDiagnosticData {
    severity: 'info' | 'warning' | 'error';
    code: string;
    message: string;
    designId?: string;
    sectionId?: string;
    slotId?: string;
    source?: ShipDesignSourceRangeData;
}

export interface ShipDesignComponentData {
    id: string;
    slot: string;
    template: string;
    source: ShipDesignSourceRangeData;
}

export interface ShipDesignSectionData {
    id: string;
    designId: string;
    occurrence: number;
    slot: string;
    template: string;
    components: ShipDesignComponentData[];
    source: ShipDesignSourceRangeData;
}

export interface ShipDesignData {
    id: string;
    occurrence: number;
    name: string;
    shipSize?: string;
    graphicalCulture?: string;
    roles?: string;
    sections: ShipDesignSectionData[];
    requiredComponents: string[];
    growthStageCount: number;
    loadoutReadOnlyReason?: string;
    metadata: Record<string, string | boolean>;
    source: ShipDesignSourceRangeData;
}

export interface ShipDesignDocumentSnapshot {
    documentVersion: number;
    generation: number;
    designs: ShipDesignData[];
    selectedDesignId?: string;
    diagnostics: ShipDesignDiagnosticData[];
    dirty: boolean;
    saving: boolean;
    canUndo: boolean;
    canRedo: boolean;
}

export interface ShipDesignStatValue {
    status: 'known' | 'partial' | 'unknown';
    value?: number;
    unit?: string;
    sources: string[];
    unresolved: string[];
}

export interface ShipDesignStatsData {
    designId: string;
    values: Record<string, ShipDesignStatValue>;
    resources: Record<string, ShipDesignStatValue>;
}

export interface ShipDesignIconData {
    key: string;
    uri?: string;
    frame: number;
    frames: number;
    width?: number;
    height?: number;
}

export interface ShipDesignSlotData {
    id: string;
    sectionId: string;
    name: string;
    kind: 'weapon' | 'utility' | 'strike_craft' | 'unknown';
    size: string;
    template: string;
    componentTypes: string[];
    locator?: string;
    fixed: boolean;
    selected?: string;
    icon?: ShipDesignIconData;
    compatible: boolean;
    reasons: string[];
    position?: { x?: number; y?: number; rotation?: number };
}

/** One required (core) component position, keyed by the ship size's `required_component_set`. */
export interface ShipDesignRequiredSlotData {
    id: string;
    componentSet?: string;
    selected?: string;
    icon?: ShipDesignIconData;
    /** True when the slot has a component set, so compatible replacements can be listed. */
    editable: boolean;
}

export interface ShipDesignSectionViewData {
    section: ShipDesignSectionData;
    entity: string;
    shouldDrawComponents: boolean;
    slots: ShipDesignSlotData[];
}

export interface ShipDesignModelNodeData {
    id: string;
    kind: 'root' | 'section' | 'component';
    entityName?: string;
    meshFile?: string;
    parentId?: string;
    locatorName?: string;
    sectionId?: string;
    slotId?: string;
    warnings: string[];
}

export interface ShipDesignViewData {
    designId: string;
    shipSize: string;
    culture: string;
    cultures: string[];
    roles: string[];
    availableSectionSlots: string[];
    sections: ShipDesignSectionViewData[];
    model: ShipDesignModelNodeData[];
    requiredSlots: ShipDesignRequiredSlotData[];
    diagnostics: ShipDesignDiagnosticData[];
    /** Incremented by the Host when cached model resources must be rebuilt from scratch. */
    assetRevision?: number;
}

/**
 * Stable identity of every model node including its ancestry. A changed key means the node and,
 * through the composed parent key, all of its descendants must be rebuilt; unchanged keys are reused.
 */
export function shipDesignModelNodeKeys(model: readonly ShipDesignModelNodeData[]): Map<string, string> {
    const byId = new Map<string, ShipDesignModelNodeData>();
    for (const node of model) if (!byId.has(node.id)) byId.set(node.id, node);
    const keys = new Map<string, string>();
    const resolve = (node: ShipDesignModelNodeData, depth: number): string => {
        const cached = keys.get(node.id);
        if (cached !== undefined) return cached;
        const own = JSON.stringify([
            node.kind, node.entityName ?? '', node.meshFile ?? '', node.locatorName ?? '',
            node.sectionId ?? '', node.slotId ?? '', node.parentId ?? '',
        ]);
        const parent = node.parentId === undefined || depth >= 8 ? undefined : byId.get(node.parentId);
        const key = parent && parent !== node ? own + '>' + resolve(parent, depth + 1) : own;
        keys.set(node.id, key);
        return key;
    };
    for (const node of byId.values()) resolve(node, 0);
    return keys;
}

export type ShipDesignTechnologyScope =
    | { kind: 'all' }
    | { kind: 'starting' }
    | { kind: 'custom'; technologies: string[] };

export interface ShipDesignGenerateOptions {
    role: string;
    technology: ShipDesignTechnologyScope;
    enforcePower: boolean;
}

export type ShipDesignLoadoutSection = {
    slot: string;
    template: string;
    components: Array<{ slot: string; template: string }>;
};

export type ShipDesignOperation =
    | { kind: 'set-field'; designId: string; field: string; value: string | boolean | null }
    | { kind: 'set-section-template'; sectionId: string; template: string }
    | { kind: 'set-component'; sectionId: string; slot: string; template: string | null }
    | { kind: 'drop-component'; sectionId: string; slot: string; template: string }
    | { kind: 'add-section'; designId: string; slot: string; template: string }
    | { kind: 'remove-section'; sectionId: string }
    | { kind: 'set-required-components'; designId: string; components: string[] }
    | { kind: 'set-required-component'; designId: string; slotId: string; template: string }
    | { kind: 'fill-empty-slots'; designId: string; componentKey: string; replaceEquipped?: boolean }
    | { kind: 'replace-loadout'; designId: string; sections: ShipDesignLoadoutSection[]; requiredComponents: string[]; autoGenerated: boolean }
    | { kind: 'create-design'; name: string; shipSize: string; graphicalCulture?: string }
    | { kind: 'duplicate-design'; designId: string; newName: string }
    | { kind: 'delete-design'; designId: string };
export interface ShipDesignLocatorAssetData {
    name: string;
    position?: [number, number, number];
    rotation?: [number, number, number];
    scale?: number;
    parentJoint?: string;
}

export interface ShipDesignMeshSettingAssetData {
    index?: number;
    name?: string;
    textureDiffuse?: string;
    textureNormal?: string;
    textureSpecular?: string;
    shader?: string;
}

export interface ShipDesignEntityAssetData {
    name: string;
    meshUri?: string;
    meshBase64?: string;
    scale?: number;
    locators: ShipDesignLocatorAssetData[];
    meshSettings: ShipDesignMeshSettingAssetData[];
    attaches: Array<{ locatorName: string; entity: ShipDesignEntityAssetData }>;
    textureMap: Record<string, string>;
}

/** A component offered by the library; `tier` is its 1-based position in the `upgrades_to` chain. */
export interface ShipDesignCandidateData {
    key: string;
    label: string;
    compatible: boolean;
    reasons: string[];
    icon?: ShipDesignIconData;
    tier?: number;
    upgradesTo?: string;
    /** Where the definition file resolves: a workspace (mod) root or the vanilla game. */
    origin?: 'vanilla' | 'mod';
}
