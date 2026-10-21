// Draft sketch for PROPOSAL-20261021-OPENCODE-JOBSTORE-POLL-RAM
// Non-production. Review before applying.

package api

import "sync"

type jobStatus struct {
    ID        string `json:"id"`
    State     string `json:"state"`
    Completed int    `json:"completed"`
    Total     int    `json:"total"`
}

type lightweightStore struct {
    mu   sync.RWMutex
    jobs map[string]*jobStatus
}

func (s *lightweightStore) get(id string) (jobStatus, bool) {
    s.mu.RLock()
    defer s.mu.RUnlock()
    j, ok := s.jobs[id]
    if !ok {
        return jobStatus{}, false
    }
    return *j, true
}
```