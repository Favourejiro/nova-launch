import { describe, it, expect } from 'vitest';
import { TOKEN_TEMPLATES } from '../../../config/tokenTemplates';
import {
    isValidTokenName,
    isValidTokenSymbol,
    isValidDecimals,
    isValidSupply,
} from '../../../utils/validation';

describe('Token template defaults pass validation', () => {
    TOKEN_TEMPLATES.forEach((template) => {
        describe(template.label, () => {
            it('has a valid token name', () => {
                expect(isValidTokenName(template.defaults.name)).toBe(true);
            });

            it('has a valid token symbol', () => {
                expect(isValidTokenSymbol(template.defaults.symbol)).toBe(true);
            });

            it('has valid decimals', () => {
                expect(isValidDecimals(template.defaults.decimals)).toBe(true);
            });

            it('has a valid initial supply', () => {
                expect(isValidSupply(template.defaults.initialSupply)).toBe(true);
            });
        });
    });

    it('0-decimal supply template (Points & Rewards) still passes supply validation', () => {
        const rewards = TOKEN_TEMPLATES.find((t) => t.id === 'rewards')!;
        expect(rewards.defaults.decimals).toBe(0);
        expect(isValidDecimals(0)).toBe(true);
        expect(isValidSupply(rewards.defaults.initialSupply)).toBe(true);
    });
});
