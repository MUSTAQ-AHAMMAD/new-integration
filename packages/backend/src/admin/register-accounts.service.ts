import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  OracleClient,
  OracleCashBankAccount,
} from '../clients/oracle/oracle.client';

export interface AccountOption {
  bankAccountId: number;
  name: string;
  currency?: string;
  isCash: boolean;
}

export interface RegisterProposal {
  registerId: string;
  registerName: string;
  region: string;
  currentBankAccountId: number | null;
  currentCashAccountId: number | null;
  proposedBankAccountId: number | null;
  proposedBankName: string | null;
  proposedCashAccountId: number | null;
  proposedCashName: string | null;
  /** 0..1 confidence of the auto-match (max of bank/cash score). */
  score: number;
}

export interface RegisterAccountsPreview {
  accounts: AccountOption[];
  proposals: RegisterProposal[];
  summary: {
    registers: number;
    oracleAccounts: number;
    autoMatched: number;
    unmatched: number;
  };
}

export interface AccountAssignment {
  registerId: string;
  bankAccountId?: number | null;
  cashAccountId?: number | null;
}

const STOPWORDS = new Set([
  'CASH',
  'BANK',
  'BRANCH',
  'MALL',
  'ACCOUNT',
  'ACCT',
  'THE',
  'CENTER',
  'CENTRE',
  'STORE',
  'AR',
  'AP',
  'KSA',
  'UAE',
  'SAR',
  'AED',
  'KWD',
  'OMR',
  'BHD',
  'NEW',
]);

@Injectable()
export class RegisterAccountsService {
  private readonly logger = new Logger(RegisterAccountsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly oracle: OracleClient,
  ) {}

  /** Significant tokens from a name (drops generic words + short fragments). */
  private tokens(s: string | null | undefined): string[] {
    return (s ?? '')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, ' ')
      .split(' ')
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  }

  /** Token-overlap score in [0,1] between a register name and an account name. */
  private score(regTokens: string[], acctTokens: string[]): number {
    if (regTokens.length === 0 || acctTokens.length === 0) return 0;
    const set = new Set(acctTokens);
    const shared = regTokens.filter((t) => set.has(t)).length;
    return shared / Math.max(regTokens.length, 1);
  }

  private isCashAccount(a: OracleCashBankAccount): boolean {
    return /\bcash\b/i.test(a.BankAccountName ?? '');
  }

  /** Fetches every AR-usable Oracle bank/cash account (paginated). */
  private async fetchAllAccounts(): Promise<OracleCashBankAccount[]> {
    const all: OracleCashBankAccount[] = [];
    const limit = 500;
    for (let offset = 0; offset < 20_000; offset += limit) {
      const page = await this.oracle.getCashBankAccounts({ limit, offset });
      all.push(...page);
      if (page.length < limit) break;
    }
    return all;
  }

  private pickBest(
    regTokens: string[],
    candidates: OracleCashBankAccount[],
  ): { account: OracleCashBankAccount | null; score: number } {
    let best: OracleCashBankAccount | null = null;
    let bestScore = 0;
    for (const c of candidates) {
      const s = this.score(regTokens, this.tokens(c.BankAccountName));
      if (s > bestScore) {
        bestScore = s;
        best = c;
      }
    }
    return { account: best, score: bestScore };
  }

  async preview(region?: string): Promise<RegisterAccountsPreview> {
    const accounts = await this.fetchAllAccounts();
    const cashAccounts = accounts.filter((a) => this.isCashAccount(a));
    const bankAccounts = accounts.filter((a) => !this.isCashAccount(a));

    const registers = await this.prisma.vendHqRegister.findMany({
      where: region ? { region } : {},
      orderBy: [{ region: 'asc' }, { registerName: 'asc' }],
    });

    let autoMatched = 0;
    const proposals: RegisterProposal[] = registers.map((r) => {
      const regTokens = this.tokens(r.registerName);
      const bank = this.pickBest(regTokens, bankAccounts);
      const cash = this.pickBest(regTokens, cashAccounts);
      const score = Math.max(bank.score, cash.score);
      if (bank.account || cash.account) autoMatched += score > 0 ? 1 : 0;
      return {
        registerId: r.id,
        registerName: r.registerName,
        region: r.region,
        currentBankAccountId:
          r.bankAccountId != null ? Number(r.bankAccountId) : null,
        currentCashAccountId:
          r.cashAccountId != null ? Number(r.cashAccountId) : null,
        proposedBankAccountId:
          bank.score > 0 && bank.account ? bank.account.BankAccountId : null,
        proposedBankName:
          bank.score > 0 && bank.account
            ? (bank.account.BankAccountName ?? null)
            : null,
        proposedCashAccountId:
          cash.score > 0 && cash.account ? cash.account.BankAccountId : null,
        proposedCashName:
          cash.score > 0 && cash.account
            ? (cash.account.BankAccountName ?? null)
            : null,
        score,
      };
    });

    return {
      accounts: accounts.map((a) => ({
        bankAccountId: a.BankAccountId,
        name: a.BankAccountName ?? String(a.BankAccountId),
        currency: a.CurrencyCode,
        isCash: this.isCashAccount(a),
      })),
      proposals,
      summary: {
        registers: registers.length,
        oracleAccounts: accounts.length,
        autoMatched,
        unmatched: registers.length - autoMatched,
      },
    };
  }

  /** Applies explicit assignments (only fields that are provided are written). */
  async apply(
    assignments: AccountAssignment[],
  ): Promise<{ updated: number; skipped: number }> {
    let updated = 0;
    let skipped = 0;
    for (const a of assignments) {
      const data: { bankAccountId?: bigint; cashAccountId?: bigint } = {};
      if (a.bankAccountId != null) data.bankAccountId = BigInt(a.bankAccountId);
      if (a.cashAccountId != null) data.cashAccountId = BigInt(a.cashAccountId);
      if (Object.keys(data).length === 0) {
        skipped += 1;
        continue;
      }
      await this.prisma.vendHqRegister.update({
        where: { id: a.registerId },
        data,
      });
      updated += 1;
    }
    this.logger.log(
      `Register account refresh: updated ${updated}, skipped ${skipped}`,
    );
    return { updated, skipped };
  }
}
