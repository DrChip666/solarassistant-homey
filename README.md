# SolarAssistant til Homey

En Homey-app der forbinder til din SolarAssistant-enhed på det lokale netværk og
viser PV-effekt, forbrug, batteri, net-import/eksport og inverter-tilstand i Homey —
samt Flow-cards til automatisering.

## Sådan kommer du i gang (ca. 10 minutter)

1. **Installer forudsætninger** på din computer (kun én gang):
   - [Node.js](https://nodejs.org/) (LTS-version er fint)
   - Homey CLI: åbn en terminal og kør:
     ```
     npm install --global homey
     ```

2. **Log ind** med din gratis Athom-konto (samme konto som Homey-appen):
   ```
   homey login
   ```
   Der åbnes en browser hvor du logger ind.

3. **Kør appen** fra denne mappe (den mappe hvor denne README ligger):
   ```
   cd solarassistant-homey
   homey app run
   ```
   - Homey CLI beder dig vælge hvilken Homey den skal køre på (vælg din).
   - Din computer skal være på samme netværk som Homey (eller forbundet via USB).
   - Terminalen viser nu live logs fra appen — lad den køre.

4. **Tilføj enheden i Homey-appen** (telefon/tablet):
   - Gå til *Enheder → Tilføj enhed*
   - Find "SolarAssistant" i listen
   - Indtast:
     - **IP-adresse**: kan efterlades tom — appen søger så automatisk efter din
       enhed på netværket (kræver at den kører på en Raspberry Pi). Virker
       auto-søgning ikke, kan du selv skrive IP'en, fx `192.168.0.100`
     - **Adgangskode**: den lokale adgangskode du satte op på enheden
       (se [solar-assistant.io/help/access/password](https://solar-assistant.io/help/access/password) hvis du ikke har sat en endnu)
   - Tryk næste — appen tester forbindelsen automatisk og opretter enheden.

5. **Se dine data**: PV-effekt, forbrug, batteri-SOC, net-import/eksport m.m.
   dukker op på enhedens side i Homey inden for få sekunder.

Når du er tilfreds, kan du stoppe `homey app run` (Ctrl+C) — appen bliver
automatisk afinstalleret igen. Vil du have den til at køre permanent uden at
holde terminalen åben, brug i stedet:
```
homey app install
```

## Hvis noget fejler

- **"Kunne ikke forbinde"** under parring: tjek at IP-adressen er korrekt, at
  enheden har en adgangskode sat, og at Homey og SolarAssistant-enheden er på
  samme netværk.
- Kopiér fejlbeskeden fra terminalen og send den videre — så kan koden rettes.

## Hvad appen indeholder

- **Live data** via WebSocket, med automatisk fallback til periodisk hentning
  (REST) hvis WebSocket-forbindelsen taber.
- **Flow-cards**:
  - Trigger: *Netretning ændret* (import/eksport)
  - Betingelse: *Batteri er over X %*
  - Handling: *Send en brugerdefineret kommando* (avanceret — skriv ethvert
    topic/værdi-par direkte til inverteren)
- **Flere enheder:** udover den samlede "overblik"-enhed kan du tilføje separate
  **Solar**-, **Batteri**- og **Net**-enheder, som Homey Energy forstår (batteriet
  som hjemmebatteri, nettet som smart meter, solcellerne som produktion).
  Enhederne deler én forbindelse til din SolarAssistant, og de nye genbruger
  din eksisterende enhed, så du kun skriver adgangskoden én gang. Ændrer du IP
  eller adgangskode på én af dem, følger de andre med.
- **SolarAssistant-værdi:** vælg en vilkårlig måling, tekst eller til/fra-værdi, din
  enhed kan levere (grupperne Status og Info), fra en liste, og få den som sin egen
  enhed - fx battericellers spænding, fasestrøm, elpris eller vejr. Skrivebeskyttet og
  uden for Homey Energy. Værdierne opdateres live via den fælles forbindelse.
- Understøtter Homeys Energi-dashboard (net-import/eksport mappes automatisk).

## Kilder

- [SolarAssistant REST API](https://solar-assistant.io/help/integration/rest-api)
- [SolarAssistant WebSocket API](https://solar-assistant.io/help/integration/websocket-api)
- [Homey Apps SDK](https://apps.developer.homey.app/)
