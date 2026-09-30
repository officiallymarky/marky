# Mermaid showcase

A tour of the diagram types Marky renders live. Edit any fence — the
diagram re-renders as you type, and syntax errors are flagged inline.

## Flowchart with subgraphs and styling

```mermaid
flowchart TB
    user([User]) --> gw[[API Gateway]]
    gw --> auth{Authenticated?}
    auth -->|no| deny[401 Reject]
    auth -->|yes| router

    subgraph services [Backend services]
        direction LR
        users[(users db)] <--> usvc[users svc]
        orders[(orders db)] <--> osvc[orders svc]
        billing[(billing db)] <--> bsvc[billing svc]
    end

    router --> services
    osvc -.->|emit events| bus{{event bus}}
    bus -.-> bsvc

    style user fill:#2d6a4f,color:#fff
    style deny fill:#7f1d1d,color:#fff
    style bus fill:#7c2d92,color:#fff
    style services fill:transparent,stroke-dasharray: 5 5
```

## Sequence diagram with alternatives and parallel work

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant FE as Frontend
    participant API as Orders API
    participant Pay as Payment service

    U->>FE: click "Place order"
    FE->>API: POST /orders
    activate API
    API->>Pay: authorize(cart)
    activate Pay

    alt authorized
        Pay-->>API: 200 auth_id
        par notifications
            API--)U: email receipt
        and
            API--)FE: order confirmed
        end
        API-->>FE: 201 Created
    else declined
        Pay-->>API: 402 Payment required
        API-->>FE: 402 with reason
    end
    deactivate Pay
    deactivate API
    Note over U,Pay: total latency budget 800 ms
```

## State machine of a document

```mermaid
stateDiagram-v2
    [*] --> Draft

    state Draft {
        [*] --> Editing
        Editing --> Preview: Ctrl+P
        Preview --> Editing: close
    }

    Draft --> Review: submit
    Review --> Draft: request changes
    Review --> Published: approve
    Published --> [*]

    Published --> Archived: after 90 days
    Archived --> [*]
```

## Entity relationship diagram

```mermaid
erDiagram
    AUTHOR ||--o{ BOOK : writes
    BOOK }o--|| GENRE : belongs-to
    BOOK ||--|{ EDITION : has
    READER ||--o{ LOAN : borrows
    EDITION ||--o{ LOAN : "is loaned as"

    AUTHOR {
        string id PK
        string name
        string email UK
    }
    BOOK {
        string id PK
        string author_id FK
        string genre_id FK
        string title
        int published_year
    }
    EDITION {
        string isbn PK
        string book_id FK
        string publisher
        date released
    }
```

## Gantt: release train

```mermaid
gantt
    title v0.4 release train
    dateFormat YYYY-MM-DD
    axisFormat %b %d

    section Hardening
    Find and replace      :active, fnr, 2026-09-28, 5d
    File tree sidebar     :ftree, after fnr, 6d
    section Exports
    HTML export           :done, html, 2026-09-30, 3d
    Pandoc docx/epub      :pdoc, after html, 4d
    section Release
    QA sweep              :qa, after ftree, 3d
    Sign and publish      :milestone, m1, after qa, 0d
```

## Class diagram

```mermaid
classDiagram
    class Document {
        +String path
        +String content
        +boolean dirty
        +save() SaveOutcome
        +reload()
    }
    class Editor {
        +getMarkdown() String
        +setFocusMode(on)
        +undo() redo()
    }
    class CommandBus {
        <<interface>>
        +dispatch(action)
    }
    Document "1" --> "1" Editor : owns
    CommandBus <|.. Editor : implements
    CommandBus <|.. Menu : emits into
    class Menu {
        +open()
        +save()
    }
```

## Pie: where the time goes

```mermaid
pie showData
    title Editor work last week
    "WYSIWYG fixes" : 9
    "Mermaid integration" : 6
    "Close/menu polish" : 3
    "Dependency scans" : 2
```

## Git graph of this release

```mermaid
gitGraph
    commit id: "v0.1 core"
    branch menu-fixes
    commit id: "destroy permission"
    commit id: "native menus"
    checkout main
    merge menu-fixes tag: "v0.2"
    branch mermaid
    commit id: "node view"
    commit id: "unique render ids" type: HIGHLIGHT
    checkout main
    merge mermaid tag: "v0.3"
    commit id: "theme persistence"
```
