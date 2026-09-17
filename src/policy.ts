/** 安全闸门策略参数。 */

export const POLICY = {
  /** 设备点检最迟须在开场前完成的分钟数；少于此值视为迟到点检。 */
  inspectionMinLeadMinutes: 30,
  /** 设备点检结果在开场前多久之内有效。 */
  inspectionMaxAgeMinutes: 240,
  /** 讲师资质须覆盖至场次结束（而非仅开场时刻）。 */
  qualificationCoverSessionEnd: true,
  /** 场次未指定脚本时，例外放行的默认有效期（分钟）。 */
  defaultExceptionValidityMinutes: 120,
} as const;
