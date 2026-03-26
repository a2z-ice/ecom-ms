  No, CSRF is not a real concern in this architecture. The three conditions for a CSRF attack are:                                 
                                                                                                                                   
  1. Automatic credential attachment — browsers auto-send cookies                                                                  
  2. Cross-origin request capability — attacker can trigger requests to your domain                                                
  3. Predictable request structure — attacker knows the API shape                                                                  
                                                                                                                                   
  Your architecture breaks condition #1 completely. JWTs live in JavaScript memory (InMemoryWebStorage), never in cookies. A       
  malicious page at evil.com cannot access myecom.net's in-memory variables (Same-Origin Policy), so it cannot attach the          
  Authorization: Bearer header. The request arrives unauthenticated and gets a 401.                                                
                                                                                                                                 
  So why does the project have a CSRF service? Defense-in-depth:                                                                   
  - Safety net against future regressions (someone adds cookies later)
  - Request-origin verification (stolen JWT alone isn't enough — attacker also needs the CSRF token)                               
  - Security audit/compliance checkbox                                                                                           
  - Gateway-level enforcement means every backend (Java, Python, Go) is protected without per-service code    



  CSRF is not a real threat here because JWTs are stored in JavaScript memory (not cookies), so browsers can't auto-attach
  credentials on cross-origin requests — breaking the fundamental CSRF precondition. The CSRF service exists purely as             
  defense-in-depth: protecting against future cookie regressions, adding request-origin verification beyond JWT alone, satisfying  
  compliance audits, and providing language-agnostic gateway-level enforcement for all backend services.  


  In your architecture, CSRF solves zero real problems. Here's the honest breakdown:

  What CSRF traditionally solves: Preventing forged requests where the browser silently attaches cookies. Your app doesn't use
  cookies for auth — so there's nothing to forge.

  What your CSRF service actually provides today:

  1. Request-origin proof — confirms the request came from your UI, not a replayed stolen JWT. But if an attacker has XSS access to
   steal the JWT, they can steal the CSRF token from the same in-memory variable too. So this adds no real barrier.
  2. Future regression safety net — if someone adds cookie-based auth later, CSRF protection is already wired in. This is valid but
   speculative — you're paying operational cost (Redis dependency, extra network hop on every request, Go service to maintain) for
  a hypothetical future mistake.
  3. Compliance checkbox — some auditors require CSRF controls regardless. This is a business reason, not a technical one.

  The cost you're paying for it:
  - Every single request (including reads) goes through ext_authz to csrf-service — added latency
  - Redis dependency for CSRF adds a failure mode (mitigated by fail-open, but fail-open means CSRF isn't actually protecting
  anything when it matters)
  - Operational complexity: another service to deploy, monitor, scale, debug
  - The fail-open design means that when Redis is down, CSRF is silently disabled anyway — undermining the "defense-in-depth"
  argument

  Bottom line: With JWT in Authorization headers and tokens in memory-only storage, the CSRF service is architecturally redundant.
  The JWT is your CSRF protection — it's a non-ambient credential that requires explicit JavaScript to attach. The CSRF layer adds
  operational cost without solving a problem that actually exists in the current design.
                   