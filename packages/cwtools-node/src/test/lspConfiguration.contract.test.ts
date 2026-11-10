import { expect } from 'chai';
import { buildCwtoolsConfiguration } from '../hosts/lspProcessHost';

const localisation = { languages: ['english'], generatedStrings: ':0 "REPLACE_ME"' };

describe('MCP LSP configuration contract', () => {
  it('turns vanilla validation off and forwards diagnostic suppression settings', () => {
    const settings = buildCwtoolsConfiguration('stellaris', 'D:/Games/Stellaris', 'D:/rules', localisation, true, {
      ignoreCodes: ['CW274'],
      ignoreFiles: ['zz_legacy.txt'],
      localisationFilter: 'all',
    });
    expect(settings.errors).to.deep.equal({
      vanilla: false,
      ignore: ['CW274'],
      ignorefiles: ['zz_legacy.txt'],
      localisationFilter: 'all',
    });
  });

  it('defaults to no suppression when the host passes nothing', () => {
    const settings = buildCwtoolsConfiguration('stellaris', undefined, '', localisation, false);
    expect(settings.errors).to.deep.equal({
      vanilla: false, ignore: [], ignorefiles: [], localisationFilter: 'off',
    });
  });

  it('keeps the vanilla path in cache.<game> only', () => {
    const settings = buildCwtoolsConfiguration('ck3', 'D:/Games/CK3/game', 'D:/rules', localisation, false);
    const cache = settings.cache as Record<string, string>;
    expect(cache.ck3).to.equal('D:/Games/CK3/game');
    expect(cache.stellaris).to.equal('');
  });
});
