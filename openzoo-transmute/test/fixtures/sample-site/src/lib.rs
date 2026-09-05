#![no_std]
extern crate alloc;
use pinocchio::{AccountView, Address, ProgramResult};
use zoo_host::{Ctx, Val, Route};

pinocchio::program_entrypoint!(process_instruction);
pinocchio::default_allocator!();
pinocchio::nostd_panic_handler!();

const ENV: &[(&str, &str)] = &[("GREETING", "hi")];
const ROUTES: &[Route] = &[route_0, route_1];

// pages/api/hello.js: export default function handler(req, res) { res.status(200).json({ hello: req.query.name || 'world', n: Number(req.query.n) * 2 }) }
fn route_0(cx: &mut Ctx) -> Result<(), Val> {
    let mut o = Val::obj();
    let q = cx.req_query();
    let name = { let l = q.get_str("name"); if l.truthy() { l } else { Val::str("world") } };
    o.set_str("hello", name);
    o.set_str("n", Val::Num(q.get_str("n").to_num()).mul(&Val::Num(2.0)));
    o.set_str("greeting", cx.env(&Val::str("GREETING")));
    o.set_str("t", cx.now_iso());
    cx.res_status(&Val::Num(200.0));
    cx.res_json(&o);
    Ok(())
}

// app/api/counter/route.js: export async function POST() { const n = await kv.incr('hits'); return Response.json({ hits: n }) }
fn route_1(cx: &mut Ctx) -> Result<(), Val> {
    let n = cx.kv_incrby(&Val::str("hits"), &Val::Num(1.0))?;
    let mut o = Val::obj();
    o.set_str("hits", n);
    cx.respond_json(&o, &Val::Undef);
    Ok(())
}

pub fn process_instruction(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    zoo_host::dispatch(program_id, accounts, data, ROUTES, ENV)
}
