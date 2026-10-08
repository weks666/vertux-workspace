import {DatabaseSync} from 'node:sqlite';
import {TrainerError} from './prompts.mjs';

// One persistent database per deployment; no transcript, response, token or raw user ID.
export function openBudget(filename){
  const db=new DatabaseSync(filename);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
    CREATE TABLE IF NOT EXISTS trainer_usage(
      request_id TEXT PRIMARY KEY,actor TEXT NOT NULL,day TEXT NOT NULL,
      at INTEGER NOT NULL,reserved INTEGER NOT NULL,charged INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','settled','unknown')),
      reserved_nanos INTEGER NOT NULL,charged_nanos INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS trainer_usage_day ON trainer_usage(day,actor,at);`);
  return {
    reserve({requestId,actor,tokens,costNanos,now,policy}){
      if(!Number.isSafeInteger(costNanos)||costNanos<1||!Number.isSafeInteger(policy.totalBudgetNanos)||policy.totalBudgetNanos<1)throw new TrainerError(503,'money_budget_unverified');
      const day=new Date(now).toISOString().slice(0,10);
      db.exec('BEGIN IMMEDIATE');
      try{
        if(db.prepare('SELECT 1 FROM trainer_usage WHERE request_id=?').get(requestId))throw new TrainerError(409,'request_already_used');
        const total=db.prepare('SELECT COALESCE(SUM(charged),0) AS n FROM trainer_usage WHERE day=?').get(day).n;
        const own=db.prepare('SELECT COALESCE(SUM(charged),0) AS n FROM trainer_usage WHERE day=? AND actor=?').get(day,actor).n;
        const money=db.prepare('SELECT COALESCE(SUM(charged_nanos),0) AS n FROM trainer_usage').get().n;
        const burst=db.prepare('SELECT COUNT(*) AS n FROM trainer_usage WHERE actor=? AND at>?').get(actor,now-60000).n;
        const running=db.prepare("SELECT COUNT(*) AS n FROM trainer_usage WHERE actor=? AND state='pending' AND at>?").get(actor,now-60000).n;
        if(total+tokens>policy.dailyTokens||own+tokens>policy.userDailyTokens)throw new TrainerError(429,'daily_budget_exhausted');
        if(money+costNanos>policy.totalBudgetNanos)throw new TrainerError(429,'total_budget_exhausted');
        if(burst>=policy.requestsPerMinute||running>=1)throw new TrainerError(429,'please_wait');
        db.prepare("INSERT INTO trainer_usage VALUES(?,?,?,?,?,?,'pending',?,?)").run(requestId,actor,day,now,tokens,tokens,costNanos,costNanos);
        db.exec('COMMIT');
      }catch(error){db.exec('ROLLBACK');throw error;}
    },
    settle(requestId,tokens,costNanos){
      if(!Number.isSafeInteger(costNanos)||costNanos<0)throw new TrainerError(502,'cost_unverified');
      const result=db.prepare("UPDATE trainer_usage SET charged=?,charged_nanos=?,state='settled' WHERE request_id=? AND state='pending' AND reserved>=? AND reserved_nanos>=?").run(tokens,costNanos,requestId,tokens,costNanos);
      if(result.changes!==1)throw new TrainerError(502,'usage_unverified');
    },
    uncertain(requestId){db.prepare("UPDATE trainer_usage SET state='unknown' WHERE request_id=? AND state='pending'").run(requestId);},
    summary(){return db.prepare('SELECT state,COUNT(*) AS requests,SUM(charged) AS charged,SUM(charged_nanos) AS chargedNanos FROM trainer_usage GROUP BY state').all();},
    balance(totalBudgetNanos){const charged=db.prepare('SELECT COALESCE(SUM(charged_nanos),0) AS n FROM trainer_usage').get().n;return {limitUsd:totalBudgetNanos/1e9,chargedUsd:charged/1e9,availableUsd:Math.max(0,totalBudgetNanos-charged)/1e9};},
    close(){db.close();}
  };
}
