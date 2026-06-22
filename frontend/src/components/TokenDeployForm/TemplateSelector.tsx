import { Users, Star, TrendingUp, Gift, type LucideProps } from 'lucide-react';
import { TOKEN_TEMPLATES, type TokenTemplate } from '../../config/tokenTemplates';
import type { BasicInfoData } from './BasicInfoStep';

const ICON_MAP: Record<string, React.ComponentType<LucideProps>> = {
    Users,
    Star,
    TrendingUp,
    Gift,
};

interface TemplateSelectorProps {
    onSelect: (defaults: Omit<BasicInfoData, 'adminWallet'>, template: TokenTemplate) => void;
    onSkip: () => void;
    selectedId?: string | null;
}

export function TemplateSelector({ onSelect, onSkip, selectedId }: TemplateSelectorProps) {
    return (
        <div
            role="region"
            aria-label="Token templates"
            aria-live="polite"
            className="space-y-4"
        >
            <div>
                <h2 className="text-base font-semibold text-gray-900">
                    Start from a template
                </h2>
                <p className="text-sm text-gray-500 mt-0.5">
                    Choose a preset to pre-fill sensible defaults, or start with a blank form.
                </p>
            </div>

            <div
                className="grid grid-cols-1 sm:grid-cols-2 gap-3"
                role="list"
                aria-label="Available token templates"
            >
                {TOKEN_TEMPLATES.map((template) => {
                    const Icon = ICON_MAP[template.icon] ?? Gift;
                    const isSelected = selectedId === template.id;

                    return (
                        <div key={template.id} role="listitem">
                            <button
                                type="button"
                                onClick={() => onSelect(template.defaults, template)}
                                className={[
                                    'w-full text-left rounded-xl border-2 p-4 transition-all',
                                    'focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-offset-2',
                                    isSelected
                                        ? 'border-blue-500 bg-blue-50'
                                        : 'border-gray-200 bg-white hover:border-blue-300 hover:bg-gray-50',
                                ].join(' ')}
                                aria-pressed={isSelected}
                                aria-label={`${isSelected ? 'Selected: ' : ''}${template.label} — ${template.description}`}
                            >
                                <div className="flex items-start gap-3">
                                    <div
                                        className={[
                                            'flex-shrink-0 w-9 h-9 rounded-lg flex items-center justify-center',
                                            isSelected
                                                ? 'bg-blue-500 text-white'
                                                : 'bg-gray-100 text-gray-600',
                                        ].join(' ')}
                                        aria-hidden="true"
                                    >
                                        <Icon className="w-5 h-5" />
                                    </div>

                                    <div className="min-w-0">
                                        <p className="text-sm font-semibold text-gray-900 leading-tight">
                                            {template.label}
                                        </p>
                                        <p className="text-xs text-gray-500 mt-1 leading-snug">
                                            {template.description}
                                        </p>
                                        <div className="flex flex-wrap gap-1.5 mt-2">
                                            <span className="inline-flex items-center rounded-md bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
                                                {template.defaults.decimals} decimals
                                            </span>
                                            <span className="inline-flex items-center rounded-md bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
                                                {Number(template.defaults.initialSupply).toLocaleString()} supply
                                            </span>
                                        </div>
                                    </div>
                                </div>
                            </button>
                        </div>
                    );
                })}
            </div>

            <button
                type="button"
                onClick={onSkip}
                className="text-sm text-gray-500 hover:text-gray-700 underline decoration-dotted focus:outline-none focus:ring-2 focus:ring-blue-400 rounded"
                aria-label="Skip templates and start with a blank form"
            >
                Skip — start with a blank form
            </button>
        </div>
    );
}
