import * as vscode from 'vscode';
import { StrategyConfig, StrategyName } from './strategy';

export interface Config extends StrategyConfig {
  autoSwitch: boolean;
  warnThreshold: number;
  pollIntervalSeconds: number;
  inactivePollMinutes: number;
  refreshInactiveTokens: boolean;
  watchTranscripts: boolean;
  autoAddNewLogins: boolean;
  notifyOnSwitch: boolean;
  claudeConfigDir: string;
}

export function readConfig(): Config {
  const c = vscode.workspace.getConfiguration('claudeswitch');
  const num = (key: string, fallback: number, min: number) => {
    const v = Number(c.get(key, fallback));
    return Number.isFinite(v) ? Math.max(min, v) : fallback;
  };
  return {
    autoSwitch: c.get('autoSwitch', true),
    strategy: c.get<StrategyName>('strategy', 'efficient'),
    switchThreshold: Math.min(100, num('switchThreshold', 95, 50)),
    warnThreshold: num('warnThreshold', 80, 0),
    proactiveSwitching: c.get('proactiveSwitching', true),
    proactiveHorizonHours: num('proactiveHorizonHours', 24, 1),
    proactiveMinHeadroom: num('proactiveMinHeadroom', 25, 1),
    balanceMargin: num('balanceMargin', 20, 1),
    minMinutesBetweenSwitches: num('minMinutesBetweenSwitches', 30, 0),
    pollIntervalSeconds: num('pollIntervalSeconds', 120, 30),
    inactivePollMinutes: num('inactivePollMinutes', 15, 2),
    refreshInactiveTokens: c.get('refreshInactiveTokens', true),
    watchTranscripts: c.get('watchTranscripts', true),
    autoAddNewLogins: c.get('autoAddNewLogins', true),
    notifyOnSwitch: c.get('notifyOnSwitch', true),
    claudeConfigDir: c.get('claudeConfigDir', ''),
  };
}
