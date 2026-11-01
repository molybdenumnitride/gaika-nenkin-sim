/* v0.5: percentage inputs use percent/percentage-point units; cash amounts use oku JPY. */
const GaikaModel=(()=>{
  'use strict';
  const clip=(x,a,b)=>Math.max(a,Math.min(b,x));
  const known=x=>x!==null&&x!==undefined&&x!==''&&Number.isFinite(Number(x));
  const number=(x,d=0)=>known(x)?Number(x):d;
  const TOTAL_EXIT_REFERENCE=1-Math.pow(0.4,1/4);
  const OTHER_EXIT=0.03;
  const REACH_INTERCEPT=TOTAL_EXIT_REFERENCE-OTHER_EXIT-0.025*(4+6-4);
  function effectiveCredit(p){
    if(p.creditMode!=='link')return number(p.credit);
    return Math.max(0,number(p.ccy==='USD'?p.us10:p.au10)+number(p.creditSpread));
  }
  function reachProbability(credit,fxtrend,guar,target){
    if(guar!=='target')return 0;
    return clip(REACH_INTERCEPT+0.025*(credit+fxtrend-4)-0.004*(target-110),0.02,0.45);
  }
  function constraintIssues(p){
    const issues=[];
    for(const [key,max] of [['principalCost',20],['targetCost',20],['mvaRiskCost',5],['commLimit',20],['surrenderAvg',10],['fxRevenueShare',100]])if(known(p[key])&&(Number(p[key])<0||Number(p[key])>max))issues.push(key+'が入力範囲外');
    for(const key of ['marketKappa','marketKappaLevel'])if(known(p[key])&&(Number(p[key])<=0||Number(p[key])>100))issues.push(key+'が入力範囲外');
    if(p.guar==='principal'&&!known(p.principalCost))issues.push('円元本確保の保証費用が未設定');
    if(p.guar==='target'&&!known(p.targetCost))issues.push('目標到達型の追加費用が未設定');
    if(!p.mva&&!known(p.mvaRiskCost))issues.push('MVAなしの金利リスク費用が未設定');
    if(!known(p.commLimit))issues.push('累計販売手数料の上限が未設定');
    else if(p.comm>number(p.commLimit)+1e-9)issues.push('累計販売手数料が上限を超過');
    if(p.ptype==='level'&&!known(p.marketKappaLevel))issues.push('平準払用の市場換算係数が未設定');
    return issues;
  }
  function prepare(raw,env){
    const p={...raw,credit:effectiveCredit(raw)};
    const ref=p.ccy==='USD'?p.us10:p.au10;
    const rate=p.ccy==='USD'?p.usdjpy:p.usdjpy*env.usdAud;
    const [a,b,c,,dreg]=env.coef;
    const fc=p.fcmode==='link'?env.fcShareLinked(p.us10,p.jp10):p.fcshare/100;
    const marketBase=Math.exp(a+b*p.us10+c*Math.log1p(p.fxtrend/100)+dreg*p.reg);
    const kappa=number(p.ptype==='level'?p.marketKappaLevel:p.marketKappa,1);
    const Mall=marketBase*kappa*(p.ptype==='level'?1:fc);
    const wAUD=1/(1+Math.exp(-(Math.log(0.25/0.75)+0.6*(p.au10-p.us10))));
    const wccy=p.ccy==='AUD'?wAUD:1-wAUD,mkt=Mall*wccy;
    const comps=(p.comp||[]).filter(q=>q.ccy===p.ccy&&(q.ptype||'single')===p.ptype);
    const cbar=ref+(comps.length?comps.reduce((s,q)=>s+q.rate-q.ref,0)/comps.length:0);
    const utilityEnv={ref,rate,cbar};
    const Uown=env.utility(p,utilityEnv),expOwn=Math.exp(Uown);
    const denom=expOwn+p.other+comps.reduce((s,q)=>s+q.power*Math.exp(env.utility({...q,credit:ref+q.rate-q.ref},utilityEnv)),0);
    const share=expOwn/denom;
    const bank=p.bank,sec=p.sec,agent=Math.max(0,100-bank-sec),tot=bank+sec+agent||1;
    const kbar=comps.length?comps.reduce((s,q)=>s+q.comm,0)/comps.length:6;
    const cr=p.comm/kbar;
    const push=(bank*Math.pow(cr,0.5)+sec*Math.pow(cr,0.4)+agent*Math.pow(cr,0.8))/tot;
    const steadyNew=mkt*share*push*(p.reach/100)*p.brand;
    const pReach=reachProbability(p.credit,p.fxtrend,p.guar,p.target);
    const powers=comps.map(q=>Math.max(0,number(q.power))),powerSum=powers.reduce((s,x)=>s+x,0);
    const extTarget=number(p.externalTarget,110);
    const pExt=powerSum?comps.reduce((s,q,i)=>s+powers[i]*reachProbability(ref+q.rate-q.ref,p.fxtrend,q.guar,extTarget),0)/powerSum:0;
    const extCredit=powerSum?comps.reduce((s,q,i)=>s+powers[i]*(ref+q.rate-q.ref),0)/powerSum:ref;
    const referenceTerm=number(p.marketReferenceTerm,10);
    const otherInforce=mkt*referenceTerm*3;
    const invYield=ref+p.spreadAdd-(!p.mva?number(p.mvaRiskCost):0),spread=invYield-p.credit-0.3;
    const H=Math.min(p.term,10);
    const persist=clip(Math.min(1,0.55+0.05*p.sc)-0.5*pReach,0.2,1);
    const kNet=p.comm-(p.clawback/100)*p.comm*(1-persist);
    const capCost=(p.capratio/100)*(p.hurdle/100)*H*persist*100;
    const phi=p.fxfee/100/rate*100;
    const guaranteeCost=p.guar==='principal'?number(p.principalCost):p.guar==='target'?number(p.targetCost):0;
    const surrenderIncome=Math.min(Math.max(0,number(p.surrenderAvg)),p.sc)*(1-persist);
    const fxIncome=number(p.fxRevenueShare,50)/100*phi;
    const grossMargin=spread*H*persist-kNet-capCost+fxIncome+surrenderIncome-guaranteeCost;
    const unknownCosts=[];
    if(p.guar==='principal'&&!known(p.principalCost))unknownCosts.push('円元本確保');
    if(p.guar==='target'&&!known(p.targetCost))unknownCosts.push('目標到達型');
    if(!p.mva&&!known(p.mvaRiskCost))unknownCosts.push('MVAなし');
    const zeroCosts=[];
    if(p.guar==='principal'&&known(p.principalCost)&&number(p.principalCost)===0)zeroCosts.push('円元本確保');
    if(p.guar==='target'&&known(p.targetCost)&&number(p.targetCost)===0)zeroCosts.push('目標到達型');
    if(!p.mva&&known(p.mvaRiskCost)&&number(p.mvaRiskCost)===0)zeroCosts.push('MVAなし');
    return {ref,rate,mkt,Mall,marketBase,kappa,wccy,fc,cbar,credit:p.credit,U:Uown,share,push,steadyNew,pReach,pExt,extCredit,extTarget,otherInforce,persist,kNet,capCost,kbar,spread,invYield,grossMargin,phi,guaranteeCost,surrenderIncome,fxIncome,unknownCosts,zeroCosts,constraintIssues:constraintIssues(p),marketProxy:true};
  }
  function advance(p,m,B,index,cum,ramp){
    const anpNew=m.steadyNew*ramp[index];
    const premRec=B*m.pReach*(p.recap/100)+m.otherInforce*m.pExt*(p.poach/100);
    const anpRec=premRec/p.term,anp=anpNew+anpRec;
    const premTotal=p.ptype==='single'?anp*p.term:anp;
    const cnt=p.ptype==='single'?premTotal*1e8/(p.avgprem*1e4):anp*1e8/(p.avgprem*1e4/p.term);
    const Bend=B*(1-m.pReach-OTHER_EXIT)+premTotal;
    return {fy:p.launch+index,anp,anpNew,anpRec,premTotal,cnt,cum:cum+anp,B,Bend,pReach:m.pReach,pExt:m.pExt,credit:m.credit};
  }
  function calculate(p,env){
    const m=prepare(p,env),years=[];let B=p.inforce,cum=0;
    for(let i=0;i<5;i++){const y=advance(p,m,B,i,cum,env.ramp);years.push(y);B=y.Bend;cum=y.cum;}
    return {...m,years,profit:p.ptype==='level'?null:years[2].premTotal*m.grossMargin/100};
  }
  function seeded(seed){let a=seed>>>0;return()=>{a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
  function cholesky(A){const n=A.length,L=Array.from({length:n},()=>new Array(n).fill(0));for(let i=0;i<n;i++)for(let j=0;j<=i;j++){let s=A[i][j];for(let k=0;k<j;k++)s-=L[i][k]*L[j][k];L[i][j]=i===j?Math.sqrt(Math.max(s,1e-9)):s/L[j][j]}return L}
  function simulate(p,env,{N=1000,sig,corr,seed=20261102,retainBalances=false}={}){
    const rng=seeded(seed),normal=()=>{let u=0,v=0;while(!u)u=rng();while(!v)v=rng();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v)};
    const L=cholesky(corr),[sU,sA,sJ,sF]=sig,paths=[],balances=[];
    const drift=Math.log1p(p.fxtrend/100)-sF*sF/2;
    for(let k=0;k<N;k++){
      let r=p.us10,ra=p.au10,rj=p.jp10,fx=p.usdjpy,B=p.inforce,cum=0;const ys=[],bs=[];
      for(let t=0;t<5;t++){
        const z=[normal(),normal(),normal(),normal()],e=L.map(row=>row.reduce((s,v,i)=>s+v*z[i],0));
        r=Math.max(0.3,r+0.15*(p.us10-r)+sU*e[0]);ra=Math.max(0.3,ra+0.15*(p.au10-ra)+sA*e[1]);rj=Math.max(-0.3,rj+0.15*(p.jp10-rj)+sJ*e[2]);
        const nextFx=fx*Math.exp(drift+sF*e[3]),tr=(nextFx/fx-1)*100;fx=nextFx;
        const ep={...p,us10:r,au10:ra,jp10:rj,usdjpy:fx,fxtrend:tr};
        const m=prepare(ep,env),y=advance(ep,m,B,t,cum,env.ramp);ys.push(y.anp);if(retainBalances)bs.push(y);B=y.Bend;cum=y.cum;
      }
      paths.push(ys);if(retainBalances)balances.push(bs);
    }
    const q=(a,v)=>{const s=[...a].sort((a,b)=>a-b);return s[Math.floor(v*(s.length-1))]};
    return {paths,balances,stats:[0,1,2,3,4].map(t=>{const a=paths.map(x=>x[t]);return {p10:q(a,.1),p50:q(a,.5),p90:q(a,.9)}}),seed};
  }
  return {effectiveCredit,reachProbability,constraintIssues,prepare,advance,calculate,simulate,known,TOTAL_EXIT_REFERENCE,OTHER_EXIT,REACH_INTERCEPT};
})();
if(typeof module!=='undefined')module.exports=GaikaModel;
