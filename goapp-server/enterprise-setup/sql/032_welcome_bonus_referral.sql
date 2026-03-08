-- ============================================================
-- GoApp Migration: 032 - Welcome Bonus & Referral Codes
-- Adds signup bonus tracking and referral code to riders table.
-- Seeds the coin earn rule and a default referral program.
-- ============================================================

-- Track bonus and referral code per rider
ALTER TABLE riders ADD COLUMN IF NOT EXISTS welcome_bonus_claimed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE riders ADD COLUMN IF NOT EXISTS referral_code VARCHAR(20) UNIQUE;

-- Seed signup coin earn rule (100 flat coins on first profile completion)
INSERT INTO coin_earn_rules (rule_name, rule_type, flat_coins, is_active)
VALUES ('Welcome Signup Bonus', 'signup', 100, true)
ON CONFLICT DO NOTHING;

-- Seed default rider referral program (rewards stored as coins via conditions JSONB)
INSERT INTO referral_programs (program_name, referrer_reward, referee_reward, reward_type, conditions, is_active)
VALUES (
  'GoApp Rider Referral',
  0,   -- placeholder (actual coin amounts in conditions)
  0,   -- placeholder
  'wallet_credit',
  '{"reward_unit":"coins","referrer_coins":50,"referee_coins":25}'::jsonb,
  true
)
ON CONFLICT DO NOTHING;
