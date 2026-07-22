import { describe, it, expect } from 'vitest';
import {
  detectIndigenousTech, detectGovtMissionAlignment, detectSubsidies, detectFeasibilitySignals,
} from '../feasibility.js';

describe('detectIndigenousTech', () => {
  it('returns true on domestic-development signals', () => {
    expect(detectIndigenousTech('The device is indigenously developed in India, a Make in India product.')).toBe(true);
  });
  it('returns false on foreign/licensed signals', () => {
    expect(detectIndigenousTech('Core technology is licensed from a German firm, imported technology.')).toBe(false);
  });
  it('returns null with no signal', () => {
    expect(detectIndigenousTech('A startup working on clean water solutions.')).toBeNull();
  });
  it('returns null on a tie', () => {
    expect(detectIndigenousTech('Made in India but licensed from abroad.')).toBeNull();
  });
});

describe('detectGovtMissionAlignment', () => {
  it('detects distinct canonical missions', () => {
    const hits = detectGovtMissionAlignment(
      'Aligned with Make in India and the Production Linked Incentive (PLI) scheme, supporting Swachh Bharat.');
    expect(hits).toContain('Make in India');
    expect(hits).toContain('PLI');
    expect(hits).toContain('Swachh Bharat Mission');
  });
  it('returns empty when nothing matches', () => {
    expect(detectGovtMissionAlignment('Just a regular company description.')).toEqual([]);
  });
  it('maps hydrogen mission phrasing to the canonical name', () => {
    expect(detectGovtMissionAlignment('supported under the National Green Hydrogen Mission')).toContain('National Hydrogen Mission');
  });
});

describe('detectSubsidies', () => {
  it('flags land + electricity subsidy mentions as true, others null', () => {
    const s = detectSubsidies('The plant received subsidized land and a power tariff subsidy from the state.');
    expect(s.subsidy_land_electricity.land_subsidy).toBe(true);
    expect(s.subsidy_land_electricity.electricity_subsidy).toBe(true);
    expect(s.capex_subsidy_available).toBeNull();
    expect(s.opex_subsidy_available).toBeNull();
  });
  it('flags capex and opex support separately', () => {
    const s = detectSubsidies('Eligible for capex support and interest subvention on operations.');
    expect(s.capex_subsidy_available).toBe(true);
    expect(s.opex_subsidy_available).toBe(true);
  });
  it('leaves everything null (not false) when unmentioned', () => {
    const s = detectSubsidies('A company doing solid waste management.');
    expect(s.subsidy_land_electricity.land_subsidy).toBeNull();
    expect(s.subsidy_land_electricity.electricity_subsidy).toBeNull();
    expect(s.capex_subsidy_available).toBeNull();
    expect(s.opex_subsidy_available).toBeNull();
  });
});

describe('detectFeasibilitySignals', () => {
  it('combines every detector', () => {
    const f = detectFeasibilitySignals('Indigenously developed under Make in India, received subsidized land.');
    expect(f.indigenous_tech).toBe(true);
    expect(f.govt_mission_alignment).toContain('Make in India');
    expect(f.subsidy_land_electricity.land_subsidy).toBe(true);
  });
});
