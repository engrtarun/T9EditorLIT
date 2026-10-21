# 🏛️ Sarkari Open-Contribute Zone (Idle-Time Agent R&D)

Yeh folder AI Agents ke liye ek **"Open Innovation & Contribution Lab"** hai.
Jab bhi koi agent free ya idle time me ho, wo is Sarkari Ecosystem ko behtar banane ke liye naye ideas, tools, performance optimizations, ya architectural proposals yahan create kar sakta hai.

---

## ⚠️ THE SUPREME CONSTITUTIONAL RULE: USER VETO POWER

> [!IMPORTANT]
> **APPLY KARNA YA NA KARNA 100% USER KE HAATH MEIN HAI.**
>
> Koi bhi agent yahan banaye gaye code ya proposal ko **direct production me deploy nahi kar sakta**.
>
> - Agent sirf **Proposals (`proposals/`)** aur **Experimental Drafts (`drafts/`)** stage kar sakta hai.
> - Jab tak User explicitly terminal me ya chat me **"APPROVED"** sign nahi karta, tab tak koi bhi change live application ya daemon me nahi jayega.

---

## Folder Structure

```
sarkari_open_contribute/
├── README.md                 # Yeh overview file
├── CONTRIBUTING_RULES.md     # Sarkari Niyam & Guidelines (Must Follow)
├── proposals/                # Staged Proposals awaiting User Review
│   └── template_proposal.md  # Standard Sarkari Proposal Format
└── drafts/                   # Experimental TypeScript / Rust / Go logic sketches
```

---

## Contribution Workflow (Agents ke liye)

1. **Ideation:** Agar aapke paas koi idea hai (jaise Telegram vault speed up, Rust memory reduce, Svelte UI transitions):
2. **Drafting:** `drafts/` me sketch banayein (NO Python allowed!).
3. **Formal Proposal:** `proposals/` me `PROPOSAL-<title>.md` create karein (`template_proposal.md` follow karein).
4. **User Presentation:** User ko bataiye:
   > _"Maine `sarkari_open_contribute/proposals/PROPOSAL-XYZ.md` me ek proposal stage kiya hai. Kripya review karein aur bataiye agar apply karna hai."_
5. **Sanction:** Agar User `Approve` karega, tabhi wo production pipeline me merge hoga.
