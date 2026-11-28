package dev.yarvis.android.lock

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect

/** Covers the app until the user unlocks it. [onUnlock] opens the device's check. */
@Composable
fun LockScreen(lock: AppLock, state: LockState, onUnlock: () -> Unit) {
    LifecycleResumeEffect(state) {
        if (lock.takeAutoPrompt()) onUnlock()
        onPauseOrDispose { }
    }
    Surface(Modifier.fillMaxSize()) {
        // Loading shows the blank surface, so nothing flashes before the lock decides.
        if (state != LockState.Locked) return@Surface
        Column(
            Modifier.fillMaxSize().padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Icon(Icons.Filled.Lock, contentDescription = null, modifier = Modifier.size(48.dp))
            Text("Yarvis is locked", style = MaterialTheme.typography.titleLarge)
            Button(onClick = onUnlock) { Text("Unlock") }
        }
    }
}
