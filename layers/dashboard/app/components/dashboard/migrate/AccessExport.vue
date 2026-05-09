<script setup lang="ts">
import type { DateRange, DateValue } from 'reka-ui'
import { getLocalTimeZone, now, startOfMonth, startOfWeek } from '@internationalized/date'
import { useForm } from '@tanstack/vue-form'
import { Download, Loader } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import { z } from 'zod'

interface AccessExportForm {
  datePreset: string | null
  startAt: number
  endAt: number
  slug: string
}

const { t, locale } = useI18n()
const tz = getLocalTimeZone()
const openCustomDateRange = ref(false)
const customDateRange = ref<DateRange | undefined>()
const isExporting = ref(false)

function computeDateRange(name: string): [number, number] {
  const currentTime = now(tz)
  const presets: Record<string, () => [number, number]> = {
    'today': () => [date2unix(currentTime, 'start'), date2unix(currentTime)],
    'last-24h': () => [date2unix(currentTime.subtract({ hours: 24 })), date2unix(currentTime)],
    'this-week': () => [date2unix(startOfWeek(currentTime, locale.value || getLocale()), 'start'), date2unix(currentTime)],
    'last-7d': () => [date2unix(currentTime.subtract({ days: 7 })), date2unix(currentTime)],
    'this-month': () => [date2unix(startOfMonth(currentTime), 'start'), date2unix(currentTime)],
    'last-30d': () => [date2unix(currentTime.subtract({ days: 30 })), date2unix(currentTime)],
    'last-90d': () => [date2unix(currentTime.subtract({ days: 90 })), date2unix(currentTime)],
  }

  return (presets[name] ?? presets['last-7d']!)()
}

const defaultDateRange = computeDateRange('last-7d')
const defaultValues: AccessExportForm = {
  datePreset: 'last-7d',
  startAt: defaultDateRange[0],
  endAt: defaultDateRange[1],
  slug: '',
}

const form = useForm({
  defaultValues,
  onSubmit: async ({ value }) => {
    isExporting.value = true
    try {
      const csv = await useAPI<string>('/api/stats/export', {
        responseType: 'text',
        query: {
          startAt: value.startAt,
          endAt: value.endAt,
          slug: value.slug || undefined,
        },
      })

      saveAsCsv(csv, `sink-access-${Date.now()}.csv`)
      toast.success(t('migrate.access_export.success'))
    }
    catch (error) {
      toast.error(t('migrate.access_export.failed'), {
        description: error instanceof Error ? error.message : String(error),
      })
    }
    finally {
      isExporting.value = false
    }
  },
})

const currentStartAt = form.useStore(state => state.values.startAt)
const currentEndAt = form.useStore(state => state.values.endAt)
const currentDatePreset = form.useStore(state => state.values.datePreset)

const dateRangeLabel = computed(() => `${shortDate(currentStartAt.value, locale.value)} - ${shortDate(currentEndAt.value, locale.value)}`)

const slugFilterSchema = z.string().max(2048)

function validateSlugFilter({ value }: { value: string }) {
  const result = slugFilterSchema.safeParse(value)
  return result.success ? undefined : result.error.errors[0]?.message
}

function isDateDisabled(dateValue: DateValue) {
  return dateValue.toDate(tz) > new Date()
}

function setDateRange(range: [number, number]) {
  form.setFieldValue('startAt', range[0])
  form.setFieldValue('endAt', range[1])
}

function onPresetChange(value: string | number | bigint | Record<string, unknown> | null) {
  if (typeof value !== 'string')
    return

  if (value === 'custom') {
    customDateRange.value = {
      start: unix2date(currentStartAt.value),
      end: unix2date(currentEndAt.value),
    }
    openCustomDateRange.value = true
    form.setFieldValue('datePreset', null)
    return
  }

  form.setFieldValue('datePreset', value)
  setDateRange(computeDateRange(value))
}

function updateCustomDateRange(value: DateRange) {
  if (!value.start || !value.end)
    return

  setDateRange([date2unix(value.start, 'start'), date2unix(value.end, 'end')])
  customDateRange.value = value
  form.setFieldValue('datePreset', null)
  openCustomDateRange.value = false
}
</script>

<template>
  <Card class="h-fit">
    <CardHeader>
      <CardTitle>{{ $t('migrate.access_export.title') }}</CardTitle>
      <CardDescription>{{ $t('migrate.access_export.description') }}</CardDescription>
    </CardHeader>
    <CardContent>
      <form class="space-y-4" @submit.prevent="form.handleSubmit">
        <FieldGroup>
          <form.Field name="datePreset">
            <Field>
              <FieldLabel>{{ $t('migrate.access_export.date_range') }}</FieldLabel>
              <Select :model-value="currentDatePreset" @update:model-value="onPresetChange">
                <SelectTrigger>
                  <SelectValue v-if="currentDatePreset" />
                  <div v-else>
                    {{ dateRangeLabel }}
                  </div>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="today">
                    {{ $t('dashboard.date_picker.today') }}
                  </SelectItem>
                  <SelectItem value="last-24h">
                    {{ $t('dashboard.date_picker.last_24h') }}
                  </SelectItem>
                  <SelectSeparator />
                  <SelectItem value="this-week">
                    {{ $t('dashboard.date_picker.this_week') }}
                  </SelectItem>
                  <SelectItem value="last-7d">
                    {{ $t('dashboard.date_picker.last_7d') }}
                  </SelectItem>
                  <SelectSeparator />
                  <SelectItem value="this-month">
                    {{ $t('dashboard.date_picker.this_month') }}
                  </SelectItem>
                  <SelectItem value="last-30d">
                    {{ $t('dashboard.date_picker.last_30d') }}
                  </SelectItem>
                  <SelectSeparator />
                  <SelectItem value="last-90d">
                    {{ $t('dashboard.date_picker.last_90d') }}
                  </SelectItem>
                  <SelectSeparator />
                  <SelectItem value="custom">
                    {{ $t('dashboard.date_picker.custom') }}
                  </SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </form.Field>

          <form.Field
            v-slot="{ field }"
            name="slug"
            :validators="{ onChange: validateSlugFilter }"
          >
            <Field>
              <FieldLabel>{{ $t('migrate.access_export.slug_label') }}</FieldLabel>
              <DashboardFilters
                :filters="{ slug: field.state.value }"
                :debounce="0"
                @change="(_, value) => field.handleChange(value)"
              />
              <FieldDescription>{{ $t('migrate.access_export.slug_description') }}</FieldDescription>
              <FieldError :errors="field.state.meta.errors" />
            </Field>
          </form.Field>
        </FieldGroup>

        <Button type="submit" :disabled="isExporting">
          <Loader v-if="isExporting" class="mr-2 h-4 w-4 animate-spin" />
          <Download v-else class="mr-2 h-4 w-4" />
          <template v-if="isExporting">
            {{ $t('migrate.access_export.exporting') }}
          </template>
          <template v-else>
            {{ $t('migrate.access_export.button') }}
          </template>
        </Button>
      </form>
    </CardContent>

    <ResponsiveModal
      v-model:open="openCustomDateRange"
      :title="$t('dashboard.date_picker.custom_title')"
      content-class="w-auto md:max-w-(--breakpoint-md)"
    >
      <RangeCalendar
        :model-value="customDateRange"
        initial-focus
        weekday-format="short"
        :number-of-months="2"
        :is-date-disabled="isDateDisabled"
        @update:model-value="updateCustomDateRange"
      />
    </ResponsiveModal>
  </Card>
</template>
