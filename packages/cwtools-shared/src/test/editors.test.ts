import { expect } from 'chai';
import {
    tokenize, TokenType, safeEval, parseTechFile, applyTechLocalisation, parseSolarSystemFile,
    toRelativeOrbitAngle, parseAssetFile, parseGuiFile, parseGuiGfxFile, buildSpriteIndex, parseParticleFile,
    isGuiPreviewSnapshot, isRange, createGuiElementReference, flattenGuiElements,
} from '../editors';

/**
 * Public-behavior tests for the transport-neutral editors barrel.
 * These guard the single-source parsers that the VS Code Host and the
 * dsh-cwtools browser client both consume.
 */
describe('editors/pdxTokenizer', () => {
    it('keeps escaped double quotes inside string tokens', () => {
        const input = 'name = "Foo \\"Bar\\" Baz"\nnext = 1';
        const tokens = tokenize(input);
        const stringTokens = tokens.filter(t => t.type === TokenType.String);
        expect(stringTokens).to.have.lengthOf(1);
        expect(stringTokens[0]!.value).to.equal('Foo \\"Bar\\" Baz');
        const keys = tokens.filter(t => t.type === TokenType.Identifier).map(t => t.value);
        expect(keys).to.deep.equal(['name', 'next']);
    });
    it('counts CRLF as a single line increment', () => {
        const input = 'a = 1\r\nb = 2\r\nc = 3';
        const numbers = tokenize(input).filter(t => t.type === TokenType.Number);
        expect(numbers.map(t => t.line)).to.deep.equal([1, 2, 3]);
    });
});

describe('editors/exprEval', () => {
    it('evaluates multiplication before addition', () => {
        expect(safeEval('2 + 3 * 4')).to.equal(14);
        expect(safeEval('(2 + 3) * 4')).to.equal(20);
    });
});

describe('editors/techTreeParser', () => {
    const TECHNOLOGY = `tech_test_field = {
	area = physics
	tier = 2
	category = { field_manipulation }
	cost = 1000
	weight = 10
}`;
    it('resolves the technology category without replacing its script key', () => {
        const graph = parseTechFile(TECHNOLOGY, '/common/technology/test.txt');
        const localisation = new Map([
            ['tech_test_field', '全局能量管理'],
            ['tech_test_field_desc', '管理全局能量。'],
            ['field_manipulation', '力场操控'],
        ]);
        applyTechLocalisation(graph.nodes, key => localisation.get(key));
        expect(graph.nodes).to.have.lengthOf(1);
        expect(graph.nodes[0]).to.include({ title: '全局能量管理', category: 'field_manipulation', categoryLabel: '力场操控' });
    });
});

describe('editors/solarSystemParser', () => {
    it('accumulates orbit_angle across bodies at each hierarchical level', () => {
        const [system] = parseSolarSystemFile(`
angle_test = {
    class = sc_g
    planet = {
        class = pc_g_star
        orbit_distance = 0
        orbit_angle = 10
        planet = { class = pc_a_star orbit_distance = 10 orbit_angle = 45 }
        planet = { class = pc_b_star orbit_distance = 0 orbit_angle = 45 }
    }
    planet = {
        class = pc_continental
        orbit_distance = 30
        orbit_angle = 20
        moon = { class = pc_barren_cold orbit_distance = 10 orbit_angle = 90 }
        moon = { class = pc_barren_cold orbit_distance = 0 orbit_angle = 90 }
        moon = { class = pc_barren_cold orbit_distance = 0 orbit_angle = 90 }
        moon = { class = pc_barren_cold orbit_distance = 0 orbit_angle = 90 }
    }
    planet = { class = pc_barren orbit_distance = 20 orbit_angle = 30 }
}`);
        expect(system).to.not.equal(undefined);
        expect(system!.bodies.map(body => body.resolvedOrbitAngle)).to.deep.equal([10, 30, 60]);
        expect(toRelativeOrbitAngle(180, 90)).to.equal(90);
    });
});

describe('editors/entityAssetParser', () => {
    it('parses timed and start particle events without retaining sound-only events', () => {
        const parsed = parseAssetFile(`
entity = {
    name = "test_ship"
    pdxmesh = "test_mesh"
    state = {
        name = "death"
        state_time = 12.5
        looping = no
        start_event = { node = "engine" particle = "engine_idle" keep_particle = yes trigger_once = yes }
        event = { time = 2.5 node = "target_locator_1" particle = "small_explosion" trigger_once = yes sound = { soundeffect = "boom" } }
        event = { time = 1 sound = { soundeffect = "sound_only" } }
    }
}`, 'test.asset');
        const state = parsed.entities[0]!.states[0]!;
        expect(state.stateTime).to.equal(12.5);
        expect(state.particleEvents).to.have.length(2);
    });

    it('accepts locator rotation blocks without equals and scalar state animation names', () => {
        const parsed = parseAssetFile(`
entity = {
    name = "infernal_part"
    pdxmesh = "infernal_mesh"
    locator = { name = spiral_5 position = { 0 -0.9 0.3 } rotation { 0 0 45 } }
    default_state = "idle"
    state = { name = "idle" animation = "idle" animation_speed = 0.2
        event = { time = 0 node = "spiral_5" particle = "infernal_effect" keep_particle = yes }
    }
}`, 'infernal.asset');
        expect(parsed.entities).to.have.length(1);
        expect(parsed.entities[0]!.locators[0]!.rotation).to.deep.equal([0, 0, 45]);
        expect(parsed.entities[0]!.states[0]!.animation).to.equal('idle');
        expect(parsed.entities[0]!.states[0]!.particleEvents[0]!.particle).to.equal('infernal_effect');
    });
});

describe('editors/guiParser', () => {
    const GFX = `
spriteTypes = {
    spriteType = {
        name = "GFX_button_bg"
        texturefile = "gfx/interface/button.dds"
        noOfFrames = 1
    }
}`;
    const GUI = `
guiTypes = {
    containerWindowType = {
        name = "root_window"
        position = { x = 0 y = 0 }
        size = { width = 100 height = 40 }
        iconType = {
            name = "child_icon"
            position = { x = 5 y = 5 }
            quadTextureSprite = "GFX_button_bg"
        }
    }
}`;
    it('parses .gui hierarchies against a shared sprite index', () => {
        const sprites = parseGuiGfxFile(GFX);
        expect(sprites.map(s => s.name)).to.deep.equal(['GFX_button_bg']);
        expect(sprites[0]!.texturefile).to.equal('gfx/interface/button.dds');
        const index = buildSpriteIndex([{ path: 'a.gfx', content: GFX }]);
        const elements = parseGuiFile(GUI, index);
        expect(elements).to.have.lengthOf(1);
        const root = elements[0]!;
        expect(root.type).to.equal('containerWindowType');
        expect(root.children.some(c => c.name === 'child_icon' && c.spriteTexture === 'gfx/interface/button.dds')).to.equal(true);
        const ref = createGuiElementReference(root, '0', []);
        expect(isGuiPreviewSnapshot({ status: 'ready', elements })).to.equal(true);
        expect(flattenGuiElements(elements).length).to.be.greaterThan(1);
        expect(ref.type).to.equal('containerWindowType');
    });
});

describe('editors/particleAssetParser', () => {
    it('parses subsystem curves, ranges and colors without diagnostics', () => {
        const parsed = parseParticleFile(`
particle = {
    name = arc_emitter_muzzle
    scale = 1.000
    subsystem = {
        name = glow
        max_amount = 255
        life = { 0.250 0.500 }
        size = 4.00,grow
        color = { x = { 80 10 } y = 255 z = 64 alpha = 255,fade_alpha }
        texture = { file = "gfx/particles/beam.dds" x = 4 y = 4 shader = ParticleAdditive }
    }
}`, 'sample.asset');
        expect(parsed.diagnostics).to.deep.equal([]);
        const effect = parsed.effects[0]!;
        expect(effect.name).to.equal('arc_emitter_muzzle');
        const glow = effect.subsystems[0]!;
        expect(glow.maxAmount).to.equal(255);
        expect(glow.size && !isRange(glow.size) ? glow.size.curve : undefined).to.equal('grow');
        expect(glow.texture?.file).to.equal('gfx/particles/beam.dds');
    });
});
