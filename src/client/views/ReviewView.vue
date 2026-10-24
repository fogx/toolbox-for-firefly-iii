<template>
  <div class="review-wrap pa-4">
    <!-- Compact status bar -->
    <div class="d-flex align-center mb-3 ga-3">
      <v-progress-linear
        :model-value="items.length ? ((index + 1) / items.length) * 100 : 0"
        color="primary"
        rounded
        height="6"
        class="flex-grow-1"
      />
      <span class="text-caption text-medium-emphasis text-no-wrap">
        {{ items.length ? index + 1 : 0 }} / {{ items.length }} · {{ windowDays }}d
      </span>
      <v-btn
        density="compact"
        variant="text"
        icon="mdi-refresh"
        :loading="loading"
        @click="fetchQueue(true)"
      />
    </div>

    <v-alert
      v-if="!loading && items.length === 0"
      type="success"
      variant="tonal"
      icon="mdi-check-circle"
    >
      No uncategorized withdrawals in the last {{ windowDays }} days.
    </v-alert>

    <v-row v-if="current" no-gutters class="ga-4">
      <!-- LEFT: Invoice preview -->
      <v-col cols="12" md="6">
        <v-card variant="outlined" class="pa-0" style="height: 100%">
          <v-card-text
            v-if="!current.paperless"
            class="d-flex flex-column align-center justify-center text-medium-emphasis"
            style="min-height: 400px"
          >
            <v-icon size="48">mdi-file-hidden</v-icon>
            <div class="mt-2 text-body-2">No linked invoice</div>
            <div class="text-caption">(bank txn only)</div>
          </v-card-text>
          <template v-else>
            <div class="d-flex align-center px-3 py-2 border-b">
              <v-icon color="primary" class="mr-2">mdi-file-document</v-icon>
              <div class="flex-grow-1 text-truncate">
                <div class="text-body-2 font-weight-medium text-truncate">
                  {{ current.paperless.correspondent_name || '—' }}
                </div>
                <div class="text-caption text-medium-emphasis text-truncate">
                  {{ current.paperless.title }}
                </div>
              </div>
              <v-btn
                icon="mdi-open-in-new"
                density="compact"
                variant="text"
                :href="current.paperless.url"
                target="_blank"
                title="Open in Paperless"
              />
            </div>
            <iframe
              :key="current.paperless.id"
              :src="`${apiBase}review/doc/${current.paperless.id}/preview#zoom=page-width`"
              style="width: 100%; height: 500px; border: 0; display: block"
            />
            <div
              v-if="current.paperless.content_preview"
              class="px-3 py-2 text-caption text-medium-emphasis"
              style="white-space: pre-wrap; max-height: 100px; overflow: auto"
            >
              {{ current.paperless.content_preview }}
            </div>
          </template>
        </v-card>
      </v-col>

      <!-- RIGHT: Transaction + categorize -->
      <v-col cols="12" md="6">
        <v-card variant="outlined" class="d-flex flex-column" style="height: 100%">
          <!-- Amount + date + accounts -->
          <div class="pa-3 border-b">
            <div class="d-flex justify-space-between align-baseline">
              <span
                class="text-h5 font-weight-bold"
                :class="Number(current.amount) > 100 ? 'text-error' : ''"
              >
                −{{ formatAmount(current.amount, current.currency) }}
              </span>
              <span class="text-caption text-medium-emphasis">{{ current.date }}</span>
            </div>
            <div class="text-body-2 mt-1">
              <span class="text-medium-emphasis">{{ current.source_name }}</span>
              <v-icon size="14" class="mx-1">mdi-arrow-right</v-icon>
              <span class="font-weight-medium">{{ current.destination_name }}</span>
            </div>
            <div v-if="current.description" class="text-caption mt-1 text-medium-emphasis">
              {{ current.description }}
            </div>
            <div v-if="current.tags.length" class="mt-1">
              <v-chip
                v-for="t in current.tags"
                :key="t"
                size="x-small"
                density="compact"
                class="mr-1"
              >
                {{ t }}
              </v-chip>
            </div>
          </div>

          <!-- Suggestion callout -->
          <div v-if="current.suggested_category" class="px-3 pt-3">
            <div class="text-caption text-medium-emphasis">
              Suggested ·
              {{ current.suggestion_source ? sourceLabel[current.suggestion_source] : '' }}
            </div>
            <v-chip
              :color="
                current.suggestion_source ? sourceColor[current.suggestion_source] : 'primary'
              "
              size="large"
              label
              class="mt-1"
              @click="setCategory(current.suggested_category)"
            >
              <v-icon start>{{
                current.suggestion_source ? sourceIcon[current.suggestion_source] : 'mdi-tag'
              }}</v-icon>
              {{ current.suggested_category }}
            </v-chip>
          </div>

          <!-- Category grid — all categories visible -->
          <div class="px-3 pt-3 pb-2 flex-grow-1" style="overflow-y: auto">
            <div class="text-caption text-medium-emphasis mb-1">Pick category</div>
            <div class="d-flex flex-wrap ga-1">
              <v-chip
                v-for="c in allCategories"
                :key="c"
                :color="selectedCategory === c ? 'primary' : undefined"
                :variant="selectedCategory === c ? 'flat' : 'outlined'"
                size="small"
                label
                @click="setCategory(c)"
              >
                {{ c }}
              </v-chip>
            </div>
          </div>

          <!-- Actions -->
          <div class="pa-3 border-t d-flex ga-2">
            <v-btn
              color="success"
              :disabled="!selectedCategory || acting"
              class="flex-grow-1"
              @click="approve"
            >
              <v-icon start>mdi-check</v-icon>Approve
              <kbd class="ml-2">A</kbd>
            </v-btn>
            <v-btn variant="outlined" :disabled="acting" @click="skip">
              <v-icon start>mdi-skip-next</v-icon>Skip
              <kbd class="ml-2">S</kbd>
            </v-btn>
          </div>
        </v-card>
      </v-col>
    </v-row>

    <v-progress-linear v-if="loading && !current" indeterminate color="primary" class="mt-4" />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import api from '../services/api';

interface PaperlessDoc {
  id: number;
  title: string;
  correspondent_name: string | null;
  content_preview: string;
  url: string;
}
interface Item {
  tx_id: number;
  tj_id: number;
  date: string;
  amount: string;
  currency: string;
  description: string;
  source_name: string;
  destination_name: string;
  tags: string[];
  external_url: string | null;
  paperless: PaperlessDoc | null;
  suggested_category: string | null;
  suggestion_source: 'paperless' | 'description' | 'ai' | null;
}

const sourceColor = { paperless: 'success', ai: 'info', description: 'primary' } as const;
const sourceIcon = {
  paperless: 'mdi-file-check',
  ai: 'mdi-robot',
  description: 'mdi-text-search',
} as const;
const sourceLabel = { paperless: 'from invoice', ai: 'AI', description: 'name match' } as const;

const items = ref<Item[]>([]);
const index = ref(0);
const loading = ref(false);
const acting = ref(false);
const selectedCategory = ref<string | null>(null);
const allCategories = ref<string[]>([]);
const windowDays = ref(90);
const apiBase = `${import.meta.env.BASE_URL}api/`;

const current = computed(() => items.value[index.value] || null);

function formatAmount(a: string, c: string) {
  return `${c} ${Number(a).toFixed(2)}`;
}

function setCategory(c: string | null) {
  selectedCategory.value = c;
}

async function fetchQueue(reset = false) {
  loading.value = true;
  try {
    const r = await api.get('/review/queue', { params: { limit: 30, days: windowDays.value } });
    items.value = r.data.data.items;
    if (reset) index.value = 0;
    resetSelection();
  } finally {
    loading.value = false;
  }
}

function resetSelection() {
  // Pre-select the suggested category when advancing to a new card.
  selectedCategory.value = current.value?.suggested_category || null;
}

async function fetchCategories() {
  try {
    const r = await api.get('/review/categories');
    allCategories.value = (r.data.data || []).map((c: { name: string }) => c.name).sort();
  } catch {
    /* non-fatal */
  }
}

async function approve() {
  if (!current.value || !selectedCategory.value) return;
  acting.value = true;
  try {
    await api.post('/review/approve', {
      tx_id: current.value.tx_id,
      tj_id: current.value.tj_id,
      category_name: selectedCategory.value,
    });
    advance();
  } finally {
    acting.value = false;
  }
}

async function skip() {
  if (!current.value) return;
  acting.value = true;
  try {
    await api.post('/review/skip', { tx_id: current.value.tx_id });
    advance();
  } finally {
    acting.value = false;
  }
}

function advance() {
  if (index.value + 1 < items.value.length) {
    index.value += 1;
    resetSelection();
  } else {
    fetchQueue(true);
  }
}

function onKey(e: KeyboardEvent) {
  if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName || '')) return;
  const k = e.key.toLowerCase();
  if (k === 'a') {
    e.preventDefault();
    approve();
  } else if (k === 's') {
    e.preventDefault();
    skip();
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    advance();
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKey);
  fetchQueue(true);
  fetchCategories();
});
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<style scoped>
.review-wrap {
  max-width: 1100px;
  margin: 0 auto;
  width: 100%;
}
.border-b {
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}
.border-t {
  border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}
kbd {
  background: rgba(255, 255, 255, 0.15);
  border-radius: 3px;
  padding: 0 4px;
  font-size: 0.7em;
  font-family: monospace;
}
</style>
