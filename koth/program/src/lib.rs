//! koth-play: the "play" vault of King of the Hill, written with Pinocchio.
//!
//! A play is a deposit of Raydium CPMM LP tokens into a program-owned vault, accepted ONLY when the
//! pool behind that LP pairs the master shill token with something else. The entry flow off chain
//! (koth/src/entry.ts) turns a player's token into that LP: swap half to the master token on
//! Jupiter, create the CPMM pool if it does not exist yet, deposit both halves, then call `Play`.
//! The LP never leaves the vault: there is no withdraw instruction, so every attempt at the hill
//! is permanent liquidity for a MASTER/<token> pair.
//!
//! Instructions (first byte is the tag):
//!   0  Initialize { master_mint: [u8;32], cpmm_program: [u8;32] }
//!        [admin (signer, payer), config (pda "config"), system_program]
//!   1  Play { amount: u64 }
//!        [operator (signer, pays rent, owns source LP), player (beneficiary, any), config,
//!         pool_state (Raydium CPMM PoolState), lp_mint, source_lp (operator's LP token account),
//!         vault_lp (LP token account owned by pda "vault"), play (pda "play"+pool+player),
//!         vault_authority (pda "vault"), token_program, system_program]
//!   2  SetMaster { master_mint: [u8;32] }
//!        [admin (signer), config]
#![no_std]

use pinocchio::{
    account_info::AccountInfo,
    default_allocator,
    instruction::{Seed, Signer},
    msg, nostd_panic_handler, program_entrypoint,
    program_error::ProgramError,
    pubkey::{find_program_address, Pubkey},
    sysvars::{clock::Clock, rent::Rent, Sysvar},
    ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;
use pinocchio_token::{instructions::Transfer, state::TokenAccount};

program_entrypoint!(process_instruction);
default_allocator!();
nostd_panic_handler!();

pinocchio_pubkey::declare_id!("EWhj4iLpFxnD4w2ULdK1dgsbbGJ9s7L281rpSXgLGUmG");

// ------------------------------------------------------------------------------------------ errors

#[repr(u32)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KothError {
    InvalidInstruction = 0,
    MissingSigner = 1,
    InvalidPda = 2,
    AlreadyInitialized = 3,
    NotInitialized = 4,
    Unauthorized = 5,
    NotACpmmPool = 6,
    PoolLacksMaster = 7,
    LpMintMismatch = 8,
    TokenAccountMismatch = 9,
    ZeroAmount = 10,
    WrongProgram = 11,
    Overflow = 12,
}

impl From<KothError> for ProgramError {
    fn from(e: KothError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

// ----------------------------------------------------------------------------------------- raydium

/// The parts of Raydium's CPMM `PoolState` this program reads. Verified against live pools on
/// mainnet and devnet (koth/src/play.ts carries the same constants for the client).
pub mod raydium {
    use super::{KothError, Pubkey};

    /// sha256("account:PoolState")[..8]
    pub const POOL_STATE_DISC: [u8; 8] = [0xf7, 0xed, 0xe3, 0xf5, 0xd7, 0xc3, 0xde, 0x46];
    pub const POOL_STATE_LEN: usize = 637;
    pub const LP_MINT: usize = 136;
    pub const TOKEN_0_MINT: usize = 168;
    pub const TOKEN_1_MINT: usize = 200;
    pub const MIN_LEN: usize = TOKEN_1_MINT + 32;

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub struct PoolSides {
        pub lp_mint: Pubkey,
        pub token_0: Pubkey,
        pub token_1: Pubkey,
    }

    pub fn pool_sides(data: &[u8]) -> Result<PoolSides, KothError> {
        if data.len() < MIN_LEN || data[..8] != POOL_STATE_DISC {
            return Err(KothError::NotACpmmPool);
        }
        let pk = |at: usize| -> Pubkey {
            let mut k = [0u8; 32];
            k.copy_from_slice(&data[at..at + 32]);
            k
        };
        Ok(PoolSides { lp_mint: pk(LP_MINT), token_0: pk(TOKEN_0_MINT), token_1: pk(TOKEN_1_MINT) })
    }

    /// The non-master side of the pair, or None when the master token is not in it.
    pub fn shill_side(sides: &PoolSides, master: &Pubkey) -> Option<Pubkey> {
        if sides.token_0 == sides.token_1 {
            return None;
        }
        if &sides.token_0 == master {
            Some(sides.token_1)
        } else if &sides.token_1 == master {
            Some(sides.token_0)
        } else {
            None
        }
    }
}

// ------------------------------------------------------------------------------------------ layout

pub const CONFIG_SEED: &[u8] = b"config";
pub const VAULT_SEED: &[u8] = b"vault";
pub const PLAY_SEED: &[u8] = b"play";

pub const CONFIG_DISC: u8 = 1;
pub const PLAY_DISC: u8 = 2;

/// disc(1) admin(32) master_mint(32) cpmm_program(32) plays(8) bump(1)
pub const CONFIG_LEN: usize = 106;
pub mod config {
    pub const ADMIN: usize = 1;
    pub const MASTER_MINT: usize = 33;
    pub const CPMM_PROGRAM: usize = 65;
    pub const PLAYS: usize = 97;
    pub const BUMP: usize = 105;
}

/// disc(1) player(32) pool_state(32) lp_mint(32) shill_mint(32) amount(8) count(4) first_slot(8) last_slot(8) bump(1)
pub const PLAY_LEN: usize = 158;
pub mod play {
    pub const PLAYER: usize = 1;
    pub const POOL_STATE: usize = 33;
    pub const LP_MINT: usize = 65;
    pub const SHILL_MINT: usize = 97;
    pub const AMOUNT: usize = 129;
    pub const COUNT: usize = 137;
    pub const FIRST_SLOT: usize = 141;
    pub const LAST_SLOT: usize = 149;
    pub const BUMP: usize = 157;
}

#[inline(always)]
fn read_u64(d: &[u8], at: usize) -> u64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&d[at..at + 8]);
    u64::from_le_bytes(b)
}
#[inline(always)]
fn read_u32(d: &[u8], at: usize) -> u32 {
    let mut b = [0u8; 4];
    b.copy_from_slice(&d[at..at + 4]);
    u32::from_le_bytes(b)
}
#[inline(always)]
fn read_pk(d: &[u8], at: usize) -> Pubkey {
    let mut k = [0u8; 32];
    k.copy_from_slice(&d[at..at + 32]);
    k
}

// ------------------------------------------------------------------------------------ instructions

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Instruction {
    Initialize { master_mint: Pubkey, cpmm_program: Pubkey },
    Play { amount: u64 },
    SetMaster { master_mint: Pubkey },
}

impl Instruction {
    pub fn unpack(data: &[u8]) -> Result<Self, ProgramError> {
        match data.split_first() {
            Some((0, rest)) if rest.len() >= 64 => Ok(Instruction::Initialize {
                master_mint: read_pk(rest, 0),
                cpmm_program: read_pk(rest, 32),
            }),
            Some((1, rest)) if rest.len() >= 8 => Ok(Instruction::Play { amount: read_u64(rest, 0) }),
            Some((2, rest)) if rest.len() >= 32 => Ok(Instruction::SetMaster { master_mint: read_pk(rest, 0) }),
            _ => Err(KothError::InvalidInstruction.into()),
        }
    }
}

pub fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if program_id != &ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    match Instruction::unpack(data)? {
        Instruction::Initialize { master_mint, cpmm_program } => process_initialize(accounts, &master_mint, &cpmm_program),
        Instruction::Play { amount } => process_play(accounts, amount),
        Instruction::SetMaster { master_mint } => process_set_master(accounts, &master_mint),
    }
}

fn process_initialize(accounts: &[AccountInfo], master_mint: &Pubkey, cpmm_program: &Pubkey) -> ProgramResult {
    let [admin, config, _system_program] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if !admin.is_signer() {
        return Err(KothError::MissingSigner.into());
    }
    let (pda, bump) = find_program_address(&[CONFIG_SEED], &ID);
    if config.key() != &pda {
        return Err(KothError::InvalidPda.into());
    }
    if config.data_len() != 0 || config.is_owned_by(&ID) {
        return Err(KothError::AlreadyInitialized.into());
    }
    let bump_bytes = [bump];
    let seeds = [Seed::from(CONFIG_SEED), Seed::from(&bump_bytes)];
    CreateAccount {
        from: admin,
        to: config,
        lamports: Rent::get()?.minimum_balance(CONFIG_LEN),
        space: CONFIG_LEN as u64,
        owner: &ID,
    }
    .invoke_signed(&[Signer::from(&seeds)])?;

    let mut d = config.try_borrow_mut_data()?;
    d[0] = CONFIG_DISC;
    d[config::ADMIN..config::ADMIN + 32].copy_from_slice(admin.key());
    d[config::MASTER_MINT..config::MASTER_MINT + 32].copy_from_slice(master_mint);
    d[config::CPMM_PROGRAM..config::CPMM_PROGRAM + 32].copy_from_slice(cpmm_program);
    d[config::PLAYS..config::PLAYS + 8].copy_from_slice(&0u64.to_le_bytes());
    d[config::BUMP] = bump;
    msg!("koth: initialized");
    Ok(())
}

fn process_set_master(accounts: &[AccountInfo], master_mint: &Pubkey) -> ProgramResult {
    let [admin, config] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if !admin.is_signer() {
        return Err(KothError::MissingSigner.into());
    }
    if !config.is_owned_by(&ID) || config.data_len() != CONFIG_LEN {
        return Err(KothError::NotInitialized.into());
    }
    let mut d = config.try_borrow_mut_data()?;
    if d[0] != CONFIG_DISC || &d[config::ADMIN..config::ADMIN + 32] != admin.key().as_ref() {
        return Err(KothError::Unauthorized.into());
    }
    d[config::MASTER_MINT..config::MASTER_MINT + 32].copy_from_slice(master_mint);
    msg!("koth: master mint updated");
    Ok(())
}

fn process_play(accounts: &[AccountInfo], amount: u64) -> ProgramResult {
    let [operator, player, config, pool_state, lp_mint, source_lp, vault_lp, play_acc, vault_authority, token_program, _system_program] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if amount == 0 {
        return Err(KothError::ZeroAmount.into());
    }
    if !operator.is_signer() {
        return Err(KothError::MissingSigner.into());
    }
    if token_program.key() != &pinocchio_token::ID {
        return Err(KothError::WrongProgram.into());
    }

    // config: ours, initialized, the canonical pda
    if !config.is_owned_by(&ID) || config.data_len() != CONFIG_LEN {
        return Err(KothError::NotInitialized.into());
    }
    let (master_mint, cpmm_program) = {
        let d = config.try_borrow_data()?;
        if d[0] != CONFIG_DISC {
            return Err(KothError::NotInitialized.into());
        }
        (read_pk(&d, config::MASTER_MINT), read_pk(&d, config::CPMM_PROGRAM))
    };
    if config.key() != &find_program_address(&[CONFIG_SEED], &ID).0 {
        return Err(KothError::InvalidPda.into());
    }

    // the pool: a Raydium CPMM PoolState, owned by the CPMM program, with the master token on one side
    if !pool_state.is_owned_by(&cpmm_program) {
        return Err(KothError::NotACpmmPool.into());
    }
    let sides = {
        let d = pool_state.try_borrow_data()?;
        raydium::pool_sides(&d)?
    };
    let shill_mint = raydium::shill_side(&sides, &master_mint).ok_or(KothError::PoolLacksMaster)?;
    if lp_mint.key() != &sides.lp_mint {
        return Err(KothError::LpMintMismatch.into());
    }

    // the vault authority pda and the two LP token accounts
    let (vault_pda, _vault_bump) = find_program_address(&[VAULT_SEED], &ID);
    if vault_authority.key() != &vault_pda {
        return Err(KothError::InvalidPda.into());
    }
    {
        let src = TokenAccount::from_account_info(source_lp)?;
        if src.mint() != lp_mint.key() || src.owner() != operator.key() {
            return Err(KothError::TokenAccountMismatch.into());
        }
        if src.amount() < amount {
            return Err(ProgramError::InsufficientFunds);
        }
        let dst = TokenAccount::from_account_info(vault_lp)?;
        if dst.mint() != lp_mint.key() || dst.owner() != &vault_pda {
            return Err(KothError::TokenAccountMismatch.into());
        }
    }

    // the play record: pda ("play", pool, player), created on first play
    let (play_pda, play_bump) = find_program_address(&[PLAY_SEED, pool_state.key().as_ref(), player.key().as_ref()], &ID);
    if play_acc.key() != &play_pda {
        return Err(KothError::InvalidPda.into());
    }
    let slot = Clock::get()?.slot;
    if play_acc.data_len() == 0 {
        let bump = [play_bump];
        let seeds = [Seed::from(PLAY_SEED), Seed::from(pool_state.key()), Seed::from(player.key()), Seed::from(&bump)];
        CreateAccount {
            from: operator,
            to: play_acc,
            lamports: Rent::get()?.minimum_balance(PLAY_LEN),
            space: PLAY_LEN as u64,
            owner: &ID,
        }
        .invoke_signed(&[Signer::from(&seeds)])?;
        let mut d = play_acc.try_borrow_mut_data()?;
        d[0] = PLAY_DISC;
        d[play::PLAYER..play::PLAYER + 32].copy_from_slice(player.key());
        d[play::POOL_STATE..play::POOL_STATE + 32].copy_from_slice(pool_state.key());
        d[play::LP_MINT..play::LP_MINT + 32].copy_from_slice(lp_mint.key());
        d[play::SHILL_MINT..play::SHILL_MINT + 32].copy_from_slice(&shill_mint);
        d[play::AMOUNT..play::AMOUNT + 8].copy_from_slice(&amount.to_le_bytes());
        d[play::COUNT..play::COUNT + 4].copy_from_slice(&1u32.to_le_bytes());
        d[play::FIRST_SLOT..play::FIRST_SLOT + 8].copy_from_slice(&slot.to_le_bytes());
        d[play::LAST_SLOT..play::LAST_SLOT + 8].copy_from_slice(&slot.to_le_bytes());
        d[play::BUMP] = play_bump;
    } else {
        if !play_acc.is_owned_by(&ID) || play_acc.data_len() != PLAY_LEN {
            return Err(KothError::InvalidPda.into());
        }
        let mut d = play_acc.try_borrow_mut_data()?;
        if d[0] != PLAY_DISC || &d[play::PLAYER..play::PLAYER + 32] != player.key().as_ref() || &d[play::POOL_STATE..play::POOL_STATE + 32] != pool_state.key().as_ref() {
            return Err(KothError::InvalidPda.into());
        }
        let total = read_u64(&d, play::AMOUNT).checked_add(amount).ok_or(KothError::Overflow)?;
        let count = read_u32(&d, play::COUNT).checked_add(1).ok_or(KothError::Overflow)?;
        d[play::AMOUNT..play::AMOUNT + 8].copy_from_slice(&total.to_le_bytes());
        d[play::COUNT..play::COUNT + 4].copy_from_slice(&count.to_le_bytes());
        d[play::LAST_SLOT..play::LAST_SLOT + 8].copy_from_slice(&slot.to_le_bytes());
    }

    // the deposit itself: LP moves from the operator into the vault, for good
    Transfer { from: source_lp, to: vault_lp, authority: operator, amount }.invoke()?;

    {
        let mut d = config.try_borrow_mut_data()?;
        let plays = read_u64(&d, config::PLAYS).checked_add(1).ok_or(KothError::Overflow)?;
        d[config::PLAYS..config::PLAYS + 8].copy_from_slice(&plays.to_le_bytes());
    }
    msg!("koth: play locked");
    Ok(())
}

// ------------------------------------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    extern crate std;
    use super::*;
    use std::vec::Vec;

    fn pool_bytes(lp: u8, t0: u8, t1: u8) -> Vec<u8> {
        let mut d = std::vec![0u8; raydium::POOL_STATE_LEN];
        d[..8].copy_from_slice(&raydium::POOL_STATE_DISC);
        d[raydium::LP_MINT..raydium::LP_MINT + 32].copy_from_slice(&[lp; 32]);
        d[raydium::TOKEN_0_MINT..raydium::TOKEN_0_MINT + 32].copy_from_slice(&[t0; 32]);
        d[raydium::TOKEN_1_MINT..raydium::TOKEN_1_MINT + 32].copy_from_slice(&[t1; 32]);
        d
    }

    #[test]
    fn pool_sides_reads_the_verified_offsets() {
        let s = raydium::pool_sides(&pool_bytes(7, 1, 2)).unwrap();
        assert_eq!(s.lp_mint, [7u8; 32]);
        assert_eq!(s.token_0, [1u8; 32]);
        assert_eq!(s.token_1, [2u8; 32]);
    }

    #[test]
    fn pool_sides_rejects_wrong_discriminator_and_short_data() {
        let mut d = pool_bytes(7, 1, 2);
        d[0] ^= 1;
        assert_eq!(raydium::pool_sides(&d), Err(KothError::NotACpmmPool));
        assert_eq!(raydium::pool_sides(&pool_bytes(7, 1, 2)[..100]), Err(KothError::NotACpmmPool));
    }

    #[test]
    fn shill_side_requires_master_on_exactly_one_side() {
        let s = raydium::pool_sides(&pool_bytes(7, 1, 2)).unwrap();
        assert_eq!(raydium::shill_side(&s, &[1u8; 32]), Some([2u8; 32]));
        assert_eq!(raydium::shill_side(&s, &[2u8; 32]), Some([1u8; 32]));
        assert_eq!(raydium::shill_side(&s, &[3u8; 32]), None);
        let same = raydium::pool_sides(&pool_bytes(7, 1, 1)).unwrap();
        assert_eq!(raydium::shill_side(&same, &[1u8; 32]), None);
    }

    #[test]
    fn instructions_unpack() {
        let mut init = std::vec![0u8];
        init.extend_from_slice(&[9u8; 32]);
        init.extend_from_slice(&[8u8; 32]);
        assert_eq!(Instruction::unpack(&init).unwrap(), Instruction::Initialize { master_mint: [9u8; 32], cpmm_program: [8u8; 32] });
        let mut play = std::vec![1u8];
        play.extend_from_slice(&42u64.to_le_bytes());
        assert_eq!(Instruction::unpack(&play).unwrap(), Instruction::Play { amount: 42 });
        let mut set = std::vec![2u8];
        set.extend_from_slice(&[5u8; 32]);
        assert_eq!(Instruction::unpack(&set).unwrap(), Instruction::SetMaster { master_mint: [5u8; 32] });
        assert!(Instruction::unpack(&[3u8]).is_err());
        assert!(Instruction::unpack(&[1u8, 0, 0]).is_err());
        assert!(Instruction::unpack(&[]).is_err());
    }

    #[test]
    fn layouts_are_sized_as_documented() {
        assert_eq!(config::BUMP + 1, CONFIG_LEN);
        assert_eq!(play::BUMP + 1, PLAY_LEN);
        assert_eq!(play::AMOUNT, play::SHILL_MINT + 32);
        assert_eq!(play::LAST_SLOT + 8, play::BUMP);
    }
}
