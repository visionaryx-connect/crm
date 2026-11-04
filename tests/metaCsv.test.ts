import tamilPeriodCsv from './fixtures/meta-tamil-period.csv?raw'
import { describe, expect, it } from 'vitest'
import { normDate, parseCsv, parseMetaCsv } from '../shared/metaCsv'

const sample = [
  '﻿Campaign name,Day,Reach,Impressions,Link clicks,Landing page views,Amount spent (INR),Reporting starts,Reporting ends',
  '"Organic millets, traffic",2026-10-01,"1,200","3,400",61,44,250.5,2026-10-01,2026-10-31',
  'Brand page,01/10/2026,800,2000,,,"120",2026-10-01,2026-10-31',
  ',,,"9,999",,,,2026-10-01,2026-10-31',
].join('\r\n')

describe('Meta CSV import', () => {
  it('handles quotes, commas and BOM', () => {
    expect(parseCsv('a,"b,c","d ""e"""\r\n1,2,3')).toEqual([['a', 'b,c', 'd "e"'], ['1', '2', '3']])
  })

  it('normalises dates', () => {
    expect(normDate('2026-10-01')).toBe('2026-10-01')
    expect(normDate('1/10/2026')).toBe('2026-10-01')
    expect(normDate('Oct 1')).toBeNull()
  })

  it('maps Meta columns to metrics and skips the totals row', () => {
    const r = parseMetaCsv(sample)
    expect(r.campaigns).toEqual(['Brand page', 'Organic millets, traffic'])
    expect(r.columns).toEqual(['reach', 'impressions', 'link_clicks', 'landing_page_views', 'spend'])
    expect(r.rows).toContainEqual({ campaign: 'Organic millets, traffic', date: '2026-10-01', metric: 'impressions', value: 3400 })
    expect(r.rows).toContainEqual({ campaign: 'Brand page', date: '2026-10-01', metric: 'spend', value: 120 })
    expect(r.rows.filter((x) => x.campaign === 'Brand page' && x.metric === 'link_clicks')).toHaveLength(0)
    expect(r.warnings.join(' ')).toMatch(/Skipped 1/)
  })

  it('sums rows split by placement', () => {
    const r = parseMetaCsv('Campaign name,Day,Placement,Impressions\nA,2026-10-02,Feed,10\nA,2026-10-02,Stories,5')
    expect(r.rows).toEqual([{ campaign: 'A', date: '2026-10-02', metric: 'impressions', value: 15 }])
  })

  it('explains a missing day breakdown', () => {
    const r = parseMetaCsv('Campaign name,Impressions\nA,10')
    expect(r.rows).toHaveLength(0)
    expect(r.warnings[0]).toMatch(/Day/)
  })
})

describe('Meta CSV import: Tamil, whole-period export', () => {
  const r = parseMetaCsv(tamilPeriodCsv)
  const get = (c: string, m: string) => r.rows.find((x) => x.campaign === c && x.metric === m)?.value

  it('reads ad names and stores totals on the period end date', () => {
    expect(r.mode).toBe('period')
    expect(r.campaigns).toHaveLength(6)
    expect(r.rows.every((x) => x.date === '2026-11-02')).toBe(true)
    expect(r.warnings.join(' ')).toMatch(/no Day breakdown/)
  })

  it('maps Tamil columns and the result indicator without double counting', () => {
    expect(get('demo', 'impressions')).toBe(9989)
    expect(get('demo', 'reach')).toBe(7177)
    expect(get('demo', 'call_taps')).toBe(19)
    expect(get('demo', 'spend')).toBe(200)
    expect(get('புதிய Awareness விளம்பரம்', 'reach')).toBe(153040)
    expect(get('demo 4', 'call_taps')).toBeUndefined()
  })
})
