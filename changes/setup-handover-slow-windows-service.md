---
type: fixed
tim: TIM-0158
---
At the end of setup, a background service that is slow to start on Windows no longer triggers "The Timon background service did not answer": the window waits for it, then hands over to it by itself once it is ready, with no need to quit and reopen Timon.
