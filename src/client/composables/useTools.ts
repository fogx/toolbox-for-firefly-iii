import { computed, type ComputedRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAppStore } from '../stores/app';

/**
 * UI metadata for a tool (static, frontend-only)
 */
export interface ToolUIConfig {
  /** Unique identifier matching backend tool name */
  id: string;
  /** i18n key for navigation title */
  titleKey: string;
  /** i18n key for navigation subtitle */
  subtitleKey: string;
  /** i18n key for dashboard description */
  descriptionKey: string;
  /** Material Design icon name */
  icon: string;
  /** Color theme for the tool card */
  color: string;
  /** Vue Router route path */
  route: string;
  /** Whether this tool requires AI configuration */
  requiresAI: boolean;
}

/**
 * Tool with computed disabled state and resolved translations
 */
export interface ToolWithStatus {
  /** Unique identifier */
  id: string;
  /** Resolved display name */
  title: string;
  /** Resolved short description */
  subtitle: string;
  /** Resolved long description */
  description: string;
  /** Material Design icon name */
  icon: string;
  /** Color theme */
  color: string;
  /** Vue Router route path */
  route: string;
  /** Whether this tool requires AI */
  requiresAI: boolean;
  /** Whether the tool is currently disabled */
  disabled: boolean;
  /** Reason why the tool is disabled */
  disabledReason: string;
}

/**
 * Frontend UI configuration for tools - maps backend tool names to UI metadata
 */
export const TOOL_UI_CONFIG: Record<string, ToolUIConfig> = {
  reviewCategorizer: {
    id: 'reviewCategorizer',
    titleKey: 'Review',
    subtitleKey: 'Fast categorize with invoice context',
    descriptionKey: 'Blast through uncategorized txns w/ Paperless previews + suggestions',
    icon: 'mdi-lightning-bolt',
    color: 'red',
    route: '/review',
    requiresAI: false,
  },
  duplicateFinder: {
    id: 'duplicateFinder',
    titleKey: 'navigation.duplicates',
    subtitleKey: 'navigation.findDuplicates',
    descriptionKey: 'views.home.toolDescriptions.duplicateFinder',
    icon: 'mdi-content-copy',
    color: 'blue',
    route: '/duplicates',
    requiresAI: false,
  },
  subscriptionFinder: {
    id: 'subscriptionFinder',
    titleKey: 'navigation.subscriptions',
    subtitleKey: 'navigation.trackRecurringExpenses',
    descriptionKey: 'views.home.toolDescriptions.subscriptionFinder',
    icon: 'mdi-credit-card-clock',
    color: 'purple',
    route: '/subscriptions',
    requiresAI: false,
  },
  aiCategorySuggestions: {
    id: 'aiCategorySuggestions',
    titleKey: 'navigation.categories',
    subtitleKey: 'navigation.smartSuggestions',
    descriptionKey: 'views.home.toolDescriptions.aiCategories',
    icon: 'mdi-shape',
    color: 'teal',
    route: '/categories',
    requiresAI: true,
  },
  aiTagSuggestions: {
    id: 'aiTagSuggestions',
    titleKey: 'navigation.tags',
    subtitleKey: 'navigation.tagSuggestions',
    descriptionKey: 'views.home.toolDescriptions.aiTags',
    icon: 'mdi-tag-multiple',
    color: 'orange',
    route: '/tags',
    requiresAI: true,
  },
  amazonExtender: {
    id: 'amazonExtender',
    titleKey: 'navigation.amazon',
    subtitleKey: 'navigation.orderDetails',
    descriptionKey: 'views.home.toolDescriptions.amazonExtender',
    icon: 'mdi-package-variant',
    color: 'amber',
    route: '/amazon',
    requiresAI: false,
  },
  paypalExtender: {
    id: 'paypalExtender',
    titleKey: 'navigation.paypal',
    subtitleKey: 'navigation.paymentDetails',
    descriptionKey: 'views.home.toolDescriptions.paypalExtender',
    icon: 'mdi-credit-card-outline',
    color: 'indigo',
    route: '/paypal',
    requiresAI: false,
  },
  bankConverter: {
    id: 'bankConverter',
    titleKey: 'navigation.converter',
    subtitleKey: 'navigation.importBankExports',
    descriptionKey: 'views.home.toolDescriptions.csvImporter',
    icon: 'mdi-database-import',
    color: 'green',
    route: '/converter',
    requiresAI: false,
  },
  fintsImporter: {
    id: 'fintsImporter',
    titleKey: 'navigation.fints',
    subtitleKey: 'navigation.directBankImport',
    descriptionKey: 'views.home.toolDescriptions.fintsImporter',
    icon: 'mdi-bank-transfer',
    color: 'cyan',
    route: '/fints',
    requiresAI: false,
  },
};

/** Ordered list of tool IDs for consistent display order */
const TOOL_ORDER = [
  'reviewCategorizer',
  'duplicateFinder',
  'subscriptionFinder',
  'aiCategorySuggestions',
  'aiTagSuggestions',
  'amazonExtender',
  'paypalExtender',
  'bankConverter',
  'fintsImporter',
];

export interface UseToolsReturn {
  /** All tool UI configs (static) */
  configs: ToolUIConfig[];
  /** Tools with computed disabled status based on backend state */
  tools: ComputedRef<ToolWithStatus[]>;
  /** Only tools that are currently available (not disabled) */
  availableTools: ComputedRef<ToolWithStatus[]>;
  /** Get a specific tool UI config by ID */
  getToolConfig: (id: string) => ToolUIConfig | undefined;
}

/**
 * Composable for accessing tool definitions with availability from backend
 */
export function useTools(): UseToolsReturn {
  const { t } = useI18n();
  const appStore = useAppStore();

  const configs = TOOL_ORDER.map((id) => TOOL_UI_CONFIG[id]).filter(Boolean);

  const tools = computed<ToolWithStatus[]>(() => {
    return TOOL_ORDER.map((id) => {
      const uiConfig = TOOL_UI_CONFIG[id];
      if (!uiConfig) return null;

      // Find backend status for this tool
      const backendStatus = appStore.tools.find((t) => t.name === id);
      const available = backendStatus?.available ?? false;

      // Determine disabled reason from backend requiresConfig
      let disabledReason = '';
      if (!available && backendStatus?.requiresConfig) {
        if (backendStatus.requiresConfig.includes('FINTS_PRODUCT_ID')) {
          disabledReason = t('tools.requiresConfiguration.fints');
        } else if (backendStatus.requiresConfig.includes('AI_PROVIDER')) {
          disabledReason = t('tools.requiresConfiguration.ai');
        } else if (backendStatus.requiresConfig.includes('FIREFLY_API_URL')) {
          disabledReason = t('tools.requiresConfiguration.firefly');
        }
      }

      return {
        id: uiConfig.id,
        title: t(uiConfig.titleKey),
        subtitle: t(uiConfig.subtitleKey),
        description: t(uiConfig.descriptionKey),
        icon: uiConfig.icon,
        color: uiConfig.color,
        route: uiConfig.route,
        requiresAI: uiConfig.requiresAI,
        disabled: !available,
        disabledReason,
      };
    }).filter((t): t is ToolWithStatus => t !== null);
  });

  const availableTools = computed(() => tools.value.filter((t) => !t.disabled));

  function getToolConfig(id: string): ToolUIConfig | undefined {
    return TOOL_UI_CONFIG[id];
  }

  return {
    configs,
    tools,
    availableTools,
    getToolConfig,
  };
}
