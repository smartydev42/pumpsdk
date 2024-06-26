import {
  Commitment,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import pfIdl from "./pumpfunAbi";
import { Idl, Program, Provider } from "@coral-xyz/anchor";
import { GlobalAccount } from "./globalAccount";
import {
  CompleteEvent,
  CreateEvent,
  CreateTokenMetadata,
  PriorityFee,
  PumpFunEventHandlers,
  PumpFunEventType,
  SetParamsEvent,
  TradeEvent,
  TransactionResult,
} from "./types";
import {
  toCompleteEvent,
  toCreateEvent,
  toSetParamsEvent,
  toTradeEvent,
} from "./events";
import { MPL_TOKEN_METADATA_PROGRAM_ID } from "@metaplex-foundation/mpl-token-metadata";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAccount,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import { BondingCurveAccount } from "./bondingCurveAccount";
import { openAsBlob } from "node:fs";
import { BN } from "bn.js";
import {
  calculateWithSlippageBuy,
  calculateWithSlippageSell,
  sendTx,
} from "./util";

const AUTHORITY = "DCpJReAfonSrgohiQbTmKKbjbqVofspFRHz9yQikzooP";
const EVENT_AUTHORITY = "Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1";
const FEE_RECIPIENT = "CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM";
const PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const SYSVAR_RENT_ADDRESS = "SysvarRent111111111111111111111111111111111";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

const GLOBAL_ACCOUNT_SEED = "global";
const MINT_AUTHORITY_SEED = "mint-authority";
const BONDING_CURVE_SEED = "bonding-curve";
const METADATA_SEED = "metadata";

export const DEFAULT_DECIMALS = 6;

const DEFAULT_COMMITMENT: Commitment = "finalized";

export class PumpFunSDK {
  public program: Program<pfIdl>;
  public connection: Connection;
  constructor(provider?: Provider) {
    this.program = new Program(pfIdl as Idl, provider);
    this.connection = this.program.provider.connection;
  }

  async createAndBuy(
    creator: Keypair,
    mint: Keypair,
    createTokenMetadata: CreateTokenMetadata,
    buyAmountSol: bigint,
    slippageBasisPoints: bigint = 500n,
    priorityFees?: PriorityFee
  ): Promise<TransactionResult> {
    let globalAccount = await this.getGlobalAccount();

    let tokenMetadata: CreateTokenMetadata = await this.createTokenMetadata(createTokenMetadata);
    console.log(tokenMetadata);

    let createTx = await this.getCreateInstructions(
      creator.publicKey,
      createTokenMetadata.name,
      createTokenMetadata.symbol,
      tokenMetadata.metadataUri,
      mint
    );

    let newTx = new Transaction().add(createTx);

    if (buyAmountSol > 0) {
      const buyAmount = globalAccount.getInitialBuyPrice(buyAmountSol);
      const buyAmountWithSlippage = calculateWithSlippageBuy(
        buyAmountSol,
        slippageBasisPoints
      );
      console.log(
        `buying $${createTokenMetadata.symbol}: ${
          Number(buyAmount) / 10 ** DEFAULT_DECIMALS
        } for: ${Number(buyAmountWithSlippage) / Number(LAMPORTS_PER_SOL)} SOL`
      );

      let buyTx = await this.getBuyInstructions(
        creator.publicKey,
        mint.publicKey,
        buyAmount,
        buyAmountWithSlippage
      );
      newTx.add(buyTx);
    }

    let createResults = await sendTx(
      this.connection,
      newTx,
      creator.publicKey,
      [creator, mint],
      priorityFees
    );
    return createResults;
  }

  async buy(
    buyer: Keypair,
    mint: PublicKey,
    buyAmountSol: bigint,
    slippageBasisPoints: bigint = 500n,
    priorityFees?: PriorityFee
  ): Promise<TransactionResult> {
    let bondingCurveAccount = await this.getBondingCurveAccount(mint);
    if (!bondingCurveAccount) {
      return {
        success: false,
        error: "Bonding curve account not found",
      };
    }
    let buyAmount = bondingCurveAccount.getBuyPrice(buyAmountSol);
    let buyAmountWithSlippage = calculateWithSlippageBuy(
      buyAmountSol,
      slippageBasisPoints
    );

    console.log(
      `buying ${Number(buyAmount) / 10 ** DEFAULT_DECIMALS} for: ${
        Number(buyAmountWithSlippage) / LAMPORTS_PER_SOL
      } SOL`
    );

    let buyTx = await this.getBuyInstructions(
      buyer.publicKey,
      mint,
      buyAmount,
      buyAmountWithSlippage
    );

    let buyResults = await sendTx(
      this.connection,
      buyTx,
      buyer.publicKey,
      [buyer],
      priorityFees
    );
    return buyResults;
  }

  async sell(
    seller: Keypair,
    mint: PublicKey,
    sellAmount: bigint,
    slippageBasisPoints: bigint = 500n,
    priorityFees?: PriorityFee
  ): Promise<TransactionResult> {
    let bondingCurveAccount = await this.getBondingCurveAccount(mint);
    if (!bondingCurveAccount) {
      return {
        success: false,
        error: "Bonding curve account not found",
      };
    }

    let globalAccount = await this.getGlobalAccount();

    let minSolOutput = bondingCurveAccount.getSellPrice(
      sellAmount,
      globalAccount.feeBasisPoints
    );

    let sellAmountWithSlippage = calculateWithSlippageSell(
      minSolOutput,
      slippageBasisPoints
    );

    console.log(
      `selling ${Number(sellAmount) / 10 ** DEFAULT_DECIMALS} for: ${
        Number(sellAmountWithSlippage) / LAMPORTS_PER_SOL
      } SOL`
    );

    let sellTx = await this.getSellInstructions(
      seller.publicKey,
      mint,
      sellAmount,
      sellAmountWithSlippage
    );

    let sellResults = await sendTx(
      this.connection,
      sellTx,
      seller.publicKey,
      [seller],
      priorityFees
    );
    return sellResults;
  }

  //create token instructions
  async getCreateInstructions(
    creator: PublicKey,
    name: string,
    symbol: string,
    uri: string,
    mint: Keypair
  ) {
    const programId = new PublicKey(PROGRAM_ID);

    const [mintAuthorityPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from(MINT_AUTHORITY_SEED)],
      programId
    );

    const [bondingCurvePDA] = PublicKey.findProgramAddressSync(
      [Buffer.from(BONDING_CURVE_SEED), mint.publicKey.toBuffer()],
      programId
    );

    const [globalAccountPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from(GLOBAL_ACCOUNT_SEED)],
      new PublicKey(PROGRAM_ID)
    );

    const mplTokenMetadata = new PublicKey(MPL_TOKEN_METADATA_PROGRAM_ID);

    const [metadataPDA] = PublicKey.findProgramAddressSync(
      [
        Buffer.from(METADATA_SEED),
        mplTokenMetadata.toBuffer(),
        mint.publicKey.toBuffer(),
      ],
      mplTokenMetadata
    );

    const associatedBondingCurve = await getAssociatedTokenAddress(
      mint.publicKey,
      bondingCurvePDA,
      true
    );

    return this.program.methods
      .create(name, symbol, uri)
      .accounts({
        mint: mint.publicKey,
        mintAuthority: mintAuthorityPDA,
        bondingCurve: bondingCurvePDA,
        associatedBondingCurve: associatedBondingCurve,
        global: globalAccountPDA,
        mplTokenMetadata: mplTokenMetadata,
        metadata: metadataPDA,
        user: creator,
        systemProgram: new PublicKey(SYSTEM_PROGRAM),
        tokenProgram: new PublicKey(TOKEN_PROGRAM_ID),
        associatedTokenProgram: new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
        rent: new PublicKey(SYSVAR_RENT_ADDRESS),
        eventAuthority: new PublicKey(EVENT_AUTHORITY),
        program: new PublicKey(PROGRAM_ID),
      })
      .signers([mint])
      .transaction();
  }

  //buy
  async getBuyInstructions(
    buyer: PublicKey,
    mint: PublicKey,
    amount: bigint,
    solAmount: bigint
  ) {
    const [bondingCurvePDA] = PublicKey.findProgramAddressSync(
      [Buffer.from(BONDING_CURVE_SEED), mint.toBuffer()],
      new PublicKey(PROGRAM_ID)
    );

    const [globalAccountPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from(GLOBAL_ACCOUNT_SEED)],
      new PublicKey(PROGRAM_ID)
    );

    const associatedBondingCurve = await getAssociatedTokenAddress(
      mint,
      bondingCurvePDA,
      true
    );

    const associatedUser = await getAssociatedTokenAddress(mint, buyer, false);

    let transaction = new Transaction();

    try {
      await getAccount(this.connection, associatedUser, "confirmed");
    } catch (e) {
      transaction.add(
        createAssociatedTokenAccountInstruction(
          buyer,
          associatedUser,
          buyer,
          mint
        )
      );
    }

    transaction.add(
      await this.program.methods
        .buy(new BN(amount.toString()), new BN(solAmount.toString()))
        .accounts({
          global: globalAccountPDA,
          feeRecipient: new PublicKey(FEE_RECIPIENT),
          mint: mint,
          buyer: buyer,
          bondingCurve: bondingCurvePDA,
          associatedBondingCurve: associatedBondingCurve,
          associatedUser: associatedUser,
          user: buyer,
          systemProgram: new PublicKey(SYSTEM_PROGRAM),
          tokenProgram: new PublicKey(TOKEN_PROGRAM_ID),
          rent: new PublicKey(SYSVAR_RENT_ADDRESS),
          eventAuthority: new PublicKey(EVENT_AUTHORITY),
          program: new PublicKey(PROGRAM_ID),
        })
        .transaction()
    );

    return transaction;
  }

  //sell
  async getSellInstructions(
    seller: PublicKey,
    mint: PublicKey,
    amount: bigint,
    minSolOutput: bigint
  ) {
    const [bondingCurvePDA] = PublicKey.findProgramAddressSync(
      [Buffer.from(BONDING_CURVE_SEED), mint.toBuffer()],
      new PublicKey(PROGRAM_ID)
    );

    const [globalAccountPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from(GLOBAL_ACCOUNT_SEED)],
      new PublicKey(PROGRAM_ID)
    );

    const associatedBondingCurve = await getAssociatedTokenAddress(
      mint,
      bondingCurvePDA,
      true
    );

    const associatedUser = await getAssociatedTokenAddress(mint, seller, false);

    let transaction = new Transaction();

    transaction.add(
      await this.program.methods
        .sell(new BN(amount.toString()), new BN(minSolOutput.toString()))
        .accounts({
          global: globalAccountPDA,
          feeRecipient: new PublicKey(FEE_RECIPIENT),
          mint: mint,
          bondingCurve: bondingCurvePDA,
          associatedBondingCurve: associatedBondingCurve,
          associatedUser: associatedUser,
          user: seller,
          systemProgram: new PublicKey(SYSTEM_PROGRAM),
          associatedTokenProgram: new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
          tokenProgram: new PublicKey(TOKEN_PROGRAM_ID),
          rent: new PublicKey(SYSVAR_RENT_ADDRESS),
          eventAuthority: new PublicKey(EVENT_AUTHORITY),
          program: new PublicKey(PROGRAM_ID),
        })
        .transaction()
    );

    return transaction;
  }

  async getBondingCurveAccount(
    mint: PublicKey,
    commitment: Commitment = DEFAULT_COMMITMENT
  ) {
    const [bondingCurvePDA] = PublicKey.findProgramAddressSync(
      [Buffer.from(BONDING_CURVE_SEED), mint.toBuffer()],
      new PublicKey(PROGRAM_ID)
    );

    const tokenAccount = await this.connection.getAccountInfo(
      bondingCurvePDA,
      commitment
    );
    if (!tokenAccount) {
      return null;
    }
    return BondingCurveAccount.fromBuffer(tokenAccount!.data);
  }

  async getGlobalAccount(commitment: Commitment = DEFAULT_COMMITMENT) {
    const [globalAccountPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from(GLOBAL_ACCOUNT_SEED)],
      new PublicKey(PROGRAM_ID)
    );

    const tokenAccount = await this.connection.getAccountInfo(
      globalAccountPDA,
      commitment
    );
    console.log("getGlobalAccount");

    return GlobalAccount.fromBuffer(tokenAccount!.data);
  }

  async createTokenMetadata(create: CreateTokenMetadata) {
    let file = await openAsBlob(create.filePath);
    let formData = new FormData();
    formData.append("file", file),
      formData.append("name", create.name),
      formData.append("symbol", create.symbol),
      formData.append("description", create.description),
      formData.append("twitter", create.twitter || ""),
      formData.append("telegram", create.telegram || ""),
      formData.append("website", create.website || ""),
      formData.append("showName", "true");
    let request = await fetch("https://pump.fun/api/ipfs", {
      method: "POST",
      body: formData,
    });
    return request.json();
  }

  //EVENTS
  addEventListener<T extends PumpFunEventType>(
    eventType: T,
    callback: (
      event: PumpFunEventHandlers[T],
      slot: number,
      signature: string
    ) => void
  ) {
    return this.program.addEventListener(
      eventType,
      (event: any, slot: number, signature: string) => {
        let processedEvent;
        switch (eventType) {
          case "createEvent":
            processedEvent = toCreateEvent(event as CreateEvent);
            callback(
              processedEvent as PumpFunEventHandlers[T],
              slot,
              signature
            );
            break;
          case "tradeEvent":
            processedEvent = toTradeEvent(event as TradeEvent);
            callback(
              processedEvent as PumpFunEventHandlers[T],
              slot,
              signature
            );
            break;
          case "completeEvent":
            processedEvent = toCompleteEvent(event as CompleteEvent);
            callback(
              processedEvent as PumpFunEventHandlers[T],
              slot,
              signature
            );
            console.log("completeEvent", event, slot, signature);
            break;
          case "setParamsEvent":
            processedEvent = toSetParamsEvent(event as SetParamsEvent);
            callback(
              processedEvent as PumpFunEventHandlers[T],
              slot,
              signature
            );
            break;
          default:
            console.error("Unhandled event type:", eventType);
        }
      }
    );
  }

  removeEventListener(eventId: number) {
    this.program.removeEventListener(eventId);
  }
}
