import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TemplateSelector } from '../TemplateSelector';
import { TOKEN_TEMPLATES } from '../../../config/tokenTemplates';

describe('TemplateSelector', () => {
    const onSelect = vi.fn();
    const onSkip = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('renders all template cards', () => {
        render(<TemplateSelector onSelect={onSelect} onSkip={onSkip} />);
        TOKEN_TEMPLATES.forEach((t) => {
            expect(screen.getByText(t.label)).toBeInTheDocument();
        });
    });

    it('renders skip button', () => {
        render(<TemplateSelector onSelect={onSelect} onSkip={onSkip} />);
        expect(
            screen.getByRole('button', { name: /skip/i })
        ).toBeInTheDocument();
    });

    it('calls onSkip when skip button is clicked', () => {
        render(<TemplateSelector onSelect={onSelect} onSkip={onSkip} />);
        fireEvent.click(screen.getByRole('button', { name: /skip/i }));
        expect(onSkip).toHaveBeenCalledTimes(1);
        expect(onSelect).not.toHaveBeenCalled();
    });

    it('calls onSelect with correct defaults and template when a card is clicked', () => {
        render(<TemplateSelector onSelect={onSelect} onSkip={onSkip} />);
        const community = TOKEN_TEMPLATES.find((t) => t.id === 'community')!;

        fireEvent.click(screen.getByText(community.label).closest('button')!);

        expect(onSelect).toHaveBeenCalledTimes(1);
        expect(onSelect).toHaveBeenCalledWith(community.defaults, community);
    });

    it('populates correct defaults for Community Token', () => {
        render(<TemplateSelector onSelect={onSelect} onSkip={onSkip} />);
        const community = TOKEN_TEMPLATES.find((t) => t.id === 'community')!;
        fireEvent.click(screen.getByText(community.label).closest('button')!);

        const [defaults] = onSelect.mock.calls[0];
        expect(defaults.name).toBe('Community Token');
        expect(defaults.symbol).toBe('CMTY');
        expect(defaults.decimals).toBe(7);
        expect(defaults.initialSupply).toBe('1000000');
    });

    it('populates correct defaults for Creator Fan Token', () => {
        render(<TemplateSelector onSelect={onSelect} onSkip={onSkip} />);
        const creator = TOKEN_TEMPLATES.find((t) => t.id === 'creator')!;
        fireEvent.click(screen.getByText(creator.label).closest('button')!);

        const [defaults] = onSelect.mock.calls[0];
        expect(defaults.name).toBe('Fan Token');
        expect(defaults.symbol).toBe('FAN');
        expect(defaults.decimals).toBe(7);
        expect(defaults.initialSupply).toBe('10000000');
    });

    it('populates correct defaults for Startup Equity Token', () => {
        render(<TemplateSelector onSelect={onSelect} onSkip={onSkip} />);
        const startup = TOKEN_TEMPLATES.find((t) => t.id === 'startup')!;
        fireEvent.click(screen.getByText(startup.label).closest('button')!);

        const [defaults] = onSelect.mock.calls[0];
        expect(defaults.name).toBe('Equity Token');
        expect(defaults.symbol).toBe('EQT');
        expect(defaults.decimals).toBe(2);
        expect(defaults.initialSupply).toBe('100000000');
    });

    it('populates correct defaults for Points & Rewards', () => {
        render(<TemplateSelector onSelect={onSelect} onSkip={onSkip} />);
        const rewards = TOKEN_TEMPLATES.find((t) => t.id === 'rewards')!;
        fireEvent.click(screen.getByText(rewards.label).closest('button')!);

        const [defaults] = onSelect.mock.calls[0];
        expect(defaults.decimals).toBe(0);
        expect(defaults.initialSupply).toBe('500000000');
    });

    it('shows selected state with aria-pressed=true for the active template', () => {
        const community = TOKEN_TEMPLATES.find((t) => t.id === 'community')!;
        render(
            <TemplateSelector
                onSelect={onSelect}
                onSkip={onSkip}
                selectedId="community"
            />
        );

        const btn = screen.getByLabelText(`Selected: ${community.label} — ${community.description}`);
        expect(btn).toHaveAttribute('aria-pressed', 'true');
    });

    it('shows non-selected state with aria-pressed=false for unselected templates', () => {
        render(
            <TemplateSelector
                onSelect={onSelect}
                onSkip={onSkip}
                selectedId="community"
            />
        );

        const creator = TOKEN_TEMPLATES.find((t) => t.id === 'creator')!;
        const btn = screen.getByLabelText(`${creator.label} — ${creator.description}`);
        expect(btn).toHaveAttribute('aria-pressed', 'false');
    });

    it('is keyboard navigable — Enter key triggers onSelect', () => {
        render(<TemplateSelector onSelect={onSelect} onSkip={onSkip} />);
        const community = TOKEN_TEMPLATES.find((t) => t.id === 'community')!;
        const btn = screen.getByText(community.label).closest('button')!;

        btn.focus();
        fireEvent.keyDown(btn, { key: 'Enter' });
        fireEvent.click(btn);

        expect(onSelect).toHaveBeenCalledWith(community.defaults, community);
    });

    it('has accessible region label', () => {
        render(<TemplateSelector onSelect={onSelect} onSkip={onSkip} />);
        expect(screen.getByRole('region', { name: 'Token templates' })).toBeInTheDocument();
    });

    it('displays decimals and supply badges for each template', () => {
        render(<TemplateSelector onSelect={onSelect} onSkip={onSkip} />);
        // Startup has 2 decimals
        expect(screen.getByText('2 decimals')).toBeInTheDocument();
        // Rewards has 0 decimals
        expect(screen.getByText('0 decimals')).toBeInTheDocument();
    });
});
