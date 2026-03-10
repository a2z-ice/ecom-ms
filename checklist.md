```txt

Create and deploy a kubernetes operator which will deploy and go base web application which will display current certificate information in its dashboard the main page and also have a renew button so when user click the renew button the cert-manager will kickoff the certificate new process and the dashboard will show the status of renewing the certificate as a ServerSendEvent so that user have a filling to see the process in live on the dashboard. Once user click the certificate new button it will prompt with a modal dialog to take user conformation. The dashboard will show certificate information with expiration date with progress bar and the progress bar will be green initailly and when the certificate expire in 10 days it will apear yellow and when 5 days remaining it will shows red progress bar. Please create go based kubernetes operator using OLM and deploy it to the kubernetes and makesure the OLM can be deployed to any k8s cluster. expose the dashboard as nodeport with hostport mapping and write all the e2e test to test the operator dashboard to ensure everything working as expected
```

```txt

Improvement: I need everything is TLS enalbled even though it is on localhost. please cerate selfsign certificate for all the access like idp.keycloak.net  myecom.net  api.service.net and also the localhost. Please makesure to use certificate manager so that the certificate rotate will happend automatically like every after 30 days and make if configurable so the we can change this value inside configmap. Make everything are working as expected and write issues and fixes step by step guide after finishing this task and also write manual step by step test document to test entire system and application

```

```txt

Create an agent team to review the entire architecture: one temmate on UX, one on technical architecture for production grade planning with proper diagram, one do plan for security, performance planning and code quality and one will do the enfrastructure portability plan so that it will be easy to deploy to EKS or AKS with mnimal configuration changes. Keep thing remember that the implementation is on kind local cluster, however we will be deploying entire things into EKS cluster so give me all the recommandation so that I will run the entire stack to the EKS with very limited changes but I do not want the EKS related native planning at the moment and do the plan to make the kind cluster as much portable as possible even if we want to go for azure AKS it will be done with very minimum configuration changes 

write review document with proper name and write step by step guideline during the entire session what issues you have found how you investigate the issues and what are the fixes and waht are the change you have made for schema registry implementation in entire cdc pipeline and what benifit does it made and also I ovserved for otl setup you remove grpc and use http instead why you did this since grpc have high performance over http explain it and makesure you do not do any security compromise to fix those issues and ensure no performance degradation 
```

sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain  /Volumes/Other/rand/llm/microservice/certs/bookstore-ca.crt