#!/usr/bin/env python3
"""Independent standard-library audit of the 2026-10-13 exam rating evidence."""
import json, math, sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / 'review/rating-v2-exam-2026-10-13/evidence.json'
OUTPUT = ROOT / 'review/rating-v2-exam-2026-10-13/independent-checks.json'
TOL = 1e-7

def dt(s): return datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()
def win(a,b): return 1/(1+10**((b-a)/400))
def expected(mu, others): return 1+sum(win(o,mu) for o in others)
def solve(mu, others, target):
    lo, hi = mu-10000, mu+10000
    for _ in range(100):
        mid=(lo+hi)/2
        if expected(mid, others)>target: lo=mid
        else: hi=mid
    return (lo+hi)/2

def round_cents(x): return math.floor(x*100+0.5)

def load(): return json.loads(EVIDENCE.read_text())

def standings(contest):
    by=defaultdict(dict)
    # Evidence preserves the source cursor order. OI-family scores therefore
    # use the last record encountered for each user/problem, without sorting.
    for r in contest['records']:
        u,p=r['uid'],r['pid']
        v=by[u].setdefault(p, {'score':0,'status':0,'ac':False,'acTime':0,'wrong':0})
        v['score']=r.get('score') or 0; v['status']=r['status']
        if r['status']==1:
            if not v['ac']:
                v['ac']=True; v['acTime']=dt(r['timestamp'])
        elif not v['ac']:
            v['wrong']+=1
    out=[]; solved={}
    for uid, probs in by.items():
        if contest['rule']=='acm':
            ss=[(p,v) for p,v in probs.items() if v['ac']]
            count=len(ss)
            penalty=sum((v['acTime']-dt(contest['beginAt']))/60+20*v['wrong'] for _,v in ss)
            total=0
            solved[uid]={p for p,_ in ss}
        else:
            total=sum(v['score'] for v in probs.values())
            solved[uid]={p for p,v in probs.items() if v['score']>=100}
            count=len(solved[uid]); penalty=0
        out.append({'uid':uid,'solved':count,'penalty':penalty,'total':total})
    out.sort(key=lambda x: ((-x['solved'],x['penalty'],x['uid']) if contest['rule']=='acm' else (-x['total'],x['uid'])))
    ranks=[0]*len(out); start=0
    while start<len(out):
        end=start+1
        while end<len(out):
            a,b=out[start],out[end]
            same=(a['solved']==b['solved'] and a['penalty']==b['penalty']) if contest['rule']=='acm' else a['total']==b['total']
            if not same: break
            end+=1
        rank=(start+1+end)/2
        ranks[start:end]=[rank]*(end-start); start=end
    return out,ranks,solved

def update(entries, ranks):
    n=len(entries)
    if len(set(ranks))==1: return {e['uid']:(e['mu'],e['events']+1,0) for e in entries}, True
    raw=[]; established=[]
    for i,e in enumerate(entries):
        others=[x['mu'] for j,x in enumerate(entries) if i!=j]
        target=math.sqrt(ranks[i]*expected(e['mu'],others))
        d=(solve(e['mu'],others,target)-e['mu'])/2
        raw.append(d); established.append(e['events']>=5)
    m=sum(d for d,b in zip(raw,established) if b)/max(1,sum(established))
    centered=[d-m if b else d for d,b in zip(raw,established)]
    sat=[200*math.tanh(d/200) for d in centered]
    em=sum(v for v,b in zip(sat,established) if b)/max(1,sum(established))
    result={}
    for e,d,b in zip(entries,sat,established):
        delta=d-em if b else d
        result[e['uid']]=(e['mu']+delta,e['events']+1,delta)
    return result,False

def fit(obs, prior_mean=1500, prior_sd=600):
    a=math.log(10)/400
    if not obs or all(x['solved'] for x in obs) or not any(x['solved'] for x in obs):
        return {'d':prior_mean,'se':None,'status':'degenerate'}
    def grad(d): return -(d-prior_mean)/(prior_sd**2)+sum(a*((1/(1+math.exp(-a*(x['mu']-d))))-(1 if x['solved'] else 0)) for x in obs)
    # Monotone score equation, solved independently by bisection.
    lo,hi=prior_mean-10000,prior_mean+10000
    for _ in range(160):
        mid=(lo+hi)/2
        if grad(mid)>0: lo=mid
        else: hi=mid
    d=(lo+hi)/2
    info=1/(prior_sd**2)+sum(a*a*(1/(1+math.exp(-a*(x['mu']-d))))*(1-1/(1+math.exp(-a*(x['mu']-d)))) for x in obs)
    return {'d':d,'se':math.sqrt(1/info),'status':'ok'}

def replay(contests, include_duration=True, maturity=1):
    states={}; observations=defaultdict(list); stage=[]; processed=skipped=frozen=0
    seen=set()
    for c in contests:
        if not include_duration and c['duration']:
            skipped+=1; continue
        ss,ranks,full=standings(c)
        if len(ss)<2:
            skipped+=1; continue
        es=[]
        for row in ss:
            s=states.setdefault(row['uid'],{'mu':1500.0,'events':0})
            es.append({'uid':row['uid'],'mu':s['mu'],'events':s['events']})
        for row,e in zip(ss,es):
            if e['events']<maturity: continue
            for pid in c['pids']:
                key=(row['uid'],pid)
                if key not in seen:
                    seen.add(key)
                    observations[pid].append({'uid':row['uid'],'mu':round(e['mu']*100)/100,'solved':pid in full[row['uid']]})
        updated,is_frozen=update(es,ranks)
        for uid,(mu,events,delta) in updated.items(): states[uid]={'mu':mu,'events':events}
        stage.append({'contestId':c['id'],'participants':len(ss),'frozen':is_frozen,'uids':len(updated)})
        processed+=1; frozen+=int(is_frozen)
    return states,observations,{'processed':processed,'skipped':skipped,'frozen':frozen,'stages':stage}

def compare_observations(obs, stored):
    calc={(o['uid'],pid):o for pid,xs in obs.items() for o in xs}
    got={(o['uid'],o['pid']):o for o in stored}; errors=[]
    for key,o in calc.items():
        g=got.get(key)
        if not g or abs(o['mu']-g['mu'])>0.0051 or o['solved']!=g['solved']:
            errors.append({'key':key,'calc':o,'got':g})
    return calc,errors,len(got)

def compare_difficulties(obs, stored):
    errors=[]; gates=[]; max_d=max_se=0.0
    for d in stored:
        xs=obs[d['pid']]; f=fit(xs); n=len(xs); pos=sum(o['solved'] for o in xs); neg=n-pos
        de=abs(f['d']-d['d']); se=abs(f['se']-d['se']) if f['se'] is not None and d['se'] is not None else 0.0
        max_d=max(max_d,de); max_se=max(max_se,se)
        if f['status']!=d['status'] or de>0.01 or (f['se'] is None)!=(d['se'] is None) or se>0.01:
            errors.append({'pid':d['pid'],'fit':f,'stored':{k:d.get(k) for k in ('d','se','status')}})
        gate=f['status']=='ok' and n>=20 and pos>=3 and neg>=3 and f['se']<=150
        if bool(d.get('provisionalLike'))!=gate: gates.append({'pid':d['pid'],'stored':d.get('provisionalLike'),'calc':gate})
    return errors,gates,max_d,max_se

def tier_for(rating):
    if rating is None: return None
    return 'TIER_1' if rating<1200 else 'TIER_2' if rating<1400 else 'TIER_3' if rating<1600 else 'TIER_4' if rating<1900 else 'TIER_5' if rating<2100 else 'TIER_6' if rating<2400 else 'TIER_7' if rating<2800 else 'TIER_8'

def inversion_count(values):
    def sort_count(xs):
        if len(xs)<2: return xs,0
        mid=len(xs)//2; left,a=sort_count(xs[:mid]); right,b=sort_count(xs[mid:]); out=[]; i=j=0; c=a+b
        while i<len(left) and j<len(right):
            if left[i]<=right[j]: out.append(left[i]); i+=1
            else: out.append(right[j]); j+=1; c+=len(left)-i
        return out+left[i:]+right[j:],c
    return sort_count(values)[1]

def check_trial_outputs(run, states, observations, ach, include_difficulty):
    docs=run['docs']; kinds=defaultdict(list)
    for d in docs: kinds[d['kind']].append(d)
    expected_states={u:s for u,s in states.items() if s['events']>0}
    stored={d['uid']:d for d in kinds['rating_state']}; errs=[]; max_mu=0.0
    for uid,s in expected_states.items():
        d=stored.get(uid); delta=abs(d['mu']-s['mu']) if d else float('inf'); max_mu=max(max_mu,delta)
        if not d or d['events']!=s['events'] or delta>1e-6: errs.append({'uid':uid,'calc':s,'stored':d})
    if len(stored)!=len(expected_states): errs.append({'storedCount':len(stored),'calculatedCount':len(expected_states)})
    obs_calc,obs_errors,obs_count=compare_observations(observations,kinds['observation']) if include_difficulty else ({},[],0)
    fit_errors=[]; gate_errors=[]; max_d=max_se=0.0
    if include_difficulty:
        fit_errors,gate_errors,max_d,max_se=compare_difficulties(observations,kinds['difficulty'])
    proj_errors=[]; max_proj_mu=0.0
    for p in kinds['projection']:
        uid=p['uid']; raw_a=ach.get(uid,0); a=math.floor(raw_a*100+0.5)/100
        s=states.get(uid); raw_mu=s['mu'] if s and s['events'] else None; mu=(math.floor(raw_mu*100+0.5)/100) if raw_mu is not None else None; events=s['events'] if s else 0
        rating=max(0,math.floor(raw_mu+0.5)) if raw_mu is not None else None
        pc=round_cents(600*raw_a/(raw_a+200)) if raw_a>0 else 0
        cc=round_cents(400*min(1,events/5)*min(1,max(0,rating/2800))) if rating is not None else 0
        muerr=abs(mu-p['mu']) if mu is not None and p['mu'] is not None else (0 if mu is None and p['mu'] is None else float('inf'))
        max_proj_mu=max(max_proj_mu,muerr)
        if (abs(a-p['a'])>1e-8 or (rating is None and p['rating'] is not None) or rating!=p['rating']
            or events!=p['ratedEvents'] or tier_for(rating)!=p['tier'] or muerr>1e-6
            or pc!=p['problemCents'] or cc!=p['contestCents'] or pc+cc!=p['rpCents']):
            proj_errors.append({'uid':uid,'mu':mu,'storedMu':p['mu'],'events':events,'storedEvents':p['ratedEvents'],'rating':rating,'storedRating':p['rating'],'tier':tier_for(rating),'storedTier':p['tier'],'parts':[pc,cc,pc+cc],'storedParts':[p['problemCents'],p['contestCents'],p['rpCents']]})
    return {'states':{'pass':not errs,'calculated':len(expected_states),'stored':len(stored),'maxMuError':max_mu,'mismatches':errs[:10]},
      'observations':{'pass':not obs_errors and len(obs_calc)==obs_count,'calculated':len(obs_calc),'stored':obs_count,'mismatches':obs_errors[:10]},
      'difficulty':{'pass':not fit_errors and not gate_errors,'fits':len(kinds['difficulty']),'maxDError':max_d,'maxSEError':max_se,'fitMismatches':fit_errors[:10],'gateMismatches':gate_errors[:10]},
      'projections':{'pass':not proj_errors,'count':len(kinds['projection']),'maxMuError':max_proj_mu,'mismatches':proj_errors[:10]}}

def main():
    data=load(); runs={r['name']:r for r in data['runs']}
    contests=sorted(data['contests'],key=lambda c:(dt(c['beginAt']),c['id']))
    checks=[]
    def check(name,ok,detail): checks.append({'name':name,'pass':bool(ok),'detail':detail})
    # Recompute achievements A and each rounded composite component.
    a_by=defaultdict(dict)
    for row in data['achievementInput']:
        if row['status']==1: unit=1.0
        elif isinstance(row.get('score'),(int,float)) and row['score']>0: unit=.5*min(1,row['score']/100)
        else: continue
        k=row['docId']; a_by[row['uid']][k]=max(a_by[row['uid']].get(k,0),unit)
    ach={u:sum(v.values()) for u,v in a_by.items()}
    # Rebuild the full candidate pool and the duration-excluded sensitivity pool
    # independently; prior1 uses one prior event for difficulty observations.
    states,observations,counts=replay(contests,True,1)
    no_states,no_observations,no_counts=replay(contests,False,1)
    ordered_contests=[]; inversions=0
    for c in contests:
        ordered=dict(c); ids=[r['id'] for r in c['records']]; inversions+=inversion_count(ids)
        ordered['records']=sorted(c['records'],key=lambda r:r['id']); ordered_contests.append(ordered)
    sorted_states,_,_=replay(ordered_contests,True,1)
    common=set(states)|set(sorted_states); changed=[]; max_order_delta=0.0
    for uid in common:
        original=states.get(uid,{'mu':1500.0,'events':0}); ordered=sorted_states.get(uid,{'mu':1500.0,'events':0})
        delta=abs(original['mu']-ordered['mu']); max_order_delta=max(max_order_delta,delta)
        if delta>1e-6 or original['events']!=ordered['events']: changed.append(uid)
    ordering_diagnostic={'recordPairInversions':inversions,'usersAffected':len(changed),'maxMuDifference':max_order_delta,'comparison':'same trial evidence, records sorted lexicographically by ObjectId ascending before per-user/problem aggregation'}
    check('trial-default and prior1 contest counts',counts['processed']==7 and counts['skipped']==1 and counts['frozen']==0,counts)
    check('no-duration contest counts',no_counts['processed']==4 and no_counts['skipped']==4 and no_counts['frozen']==0,no_counts)
    prior_audit=check_trial_outputs(runs['trial-prior1'],states,observations,ach,True)
    check('prior1 states',prior_audit['states']['pass'],prior_audit['states'])
    check('prior1 observations',prior_audit['observations']['pass'],prior_audit['observations'])
    check('prior1 difficulty MAP, SE and gates',prior_audit['difficulty']['pass'],prior_audit['difficulty'])
    check('prior1 projection mu/events/public rating/tier/components',prior_audit['projections']['pass'],prior_audit['projections'])
    default_states={d['uid']:d for d in runs['trial-default']['docs'] if d['kind']=='rating_state'}
    prior_states={d['uid']:d for d in runs['trial-prior1']['docs'] if d['kind']=='rating_state'}
    equal=set(default_states)==set(prior_states) and all(abs(default_states[u]['mu']-prior_states[u]['mu'])<1e-9 and default_states[u]['events']==prior_states[u]['events'] for u in default_states)
    check('default equals prior1 states',equal,{'default':len(default_states),'prior1':len(prior_states)})
    no_audit=check_trial_outputs(runs['trial-no-duration-prior1'],no_states,no_observations,ach,True)
    check('no-duration states',no_audit['states']['pass'],no_audit['states'])
    check('no-duration observations',no_audit['observations']['pass'],no_audit['observations'])
    check('no-duration difficulty MAP, SE and gates',no_audit['difficulty']['pass'],no_audit['difficulty'])
    check('no-duration projection mu/events/public rating/tier/components',no_audit['projections']['pass'],no_audit['projections'])
    check('source fingerprint unchanged',data.get('sourceUnchanged') is True and data['before']==data['after'],{'sourceUnchanged':data.get('sourceUnchanged'),'beforeEqualsAfter':data['before']==data['after'],'collections':list(data['before'])})
    allowed=all(w.get('collection')=='ratingv2_shadow' and w.get('command') in ('insert','delete') for w in data['writes']) and data.get('onlyShadowWrites') is True
    check('shadow-only writes',allowed,{'writeCount':len(data['writes']),'collections':sorted(set(w.get('collection') for w in data['writes'])),'onlyShadowWrites':data.get('onlyShadowWrites')})
    check('exam domain isolation',all(d.get('domainId')=='exam' for r in runs.values() for d in r['docs'] if d['kind']=='projection'),{'domains':sorted(set(d.get('domainId') for r in runs.values() for d in r['docs'] if d['kind']=='projection'))})
    check('shadow document counts',all(len(r['docs'])==sum(r['counts'].values()) and all(d['poolId']==r['options']['poolId'] for d in r['docs']) for r in runs.values()),{r['name']:{'docs':len(r['docs']),'counts':r['counts']} for r in runs.values()})
    output={'evidence':str(EVIDENCE.relative_to(ROOT)),'generatedAt':datetime.now().astimezone().isoformat(),'checks':checks,'passed':sum(c['pass'] for c in checks),'failed':sum(not c['pass'] for c in checks),'orderingDiagnostic':ordering_diagnostic,'notes':['Independent Python standard-library implementation; no Hydro algorithm module imported.','Trial OI-family scores use the evidence record cursor order; the ordering diagnostic measures sensitivity to ascending ObjectId order.','Fully tied contests increment event count, although none occurred.']}
    OUTPUT.write_text(json.dumps(output,indent=2,ensure_ascii=False)+'\n')
    print(json.dumps({'output':str(OUTPUT.relative_to(ROOT)),'passed':output['passed'],'failed':output['failed'],'checks':checks},indent=2,ensure_ascii=False))
    return 0 if output['failed']==0 else 1

if __name__=='__main__': sys.exit(main())
