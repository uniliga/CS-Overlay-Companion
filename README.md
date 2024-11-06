# This app is supposed to be used in conjunction with the Uniliga CG Overlays App and its Overlays.

The zip found in the [releases tab](https://github.com/Smudi97/uniliga-cs-gsi-fs-browser/releases) holds three files:

- Uniliga CG CS GSI 1.0.0.exe
- gamestate_integration_uniligacg.cfg
- uniliga-hud.cfg

Before you can use any of it, you should unzip the file into a folder of your choice.

Both of the .cfg files should be placed inside the cfg folder in your Counter-Strike Global Offensive\game\csgo folder, usually found at \*YourSteamLibraryHere\*\steamapps\common\Counter-Strike Global Offensive\game\csgo\cfg

Alternatively for advanced users, the options inside the hud.cfg can be added to the launch Options of your Counter-Strike app.

You can start the Uniliga CG CS GSI 1.0.0.exe at anytime and from anywhere on your system. As soon as the Uniliga CG CS GSI 1.0.0.exe is started, it will try to send any information received from CS2 to the ingame overlay.
In the Control Panel, you have the option to open the overlay (or any url specified in the URL text input) as a fullscreen overlay on your screen. It will remain on top unless you press the "Hide Overlay" Button.
You also have a few other options, among which is the "Open Message Log Window". This Window displays all messages coming in from the CS2 GSI.

If you close the control panel or click "Shutdown App", the CS2 GSI will stop communicating with the CS2 ingame overlay and thus no data will be displayed. You can close the Fullscreen Overlay and the Log Window at any time without any issues.

Once you've loaded up the game, you also have to execute the uniliga-hud.cfg inside Counter-Strike by opening the ingame console and typing in "exec uniliga-hud.cfg". This will configure the ingame hud so that only the necessary ingame elements remain visible.

That's it. Have fun.
