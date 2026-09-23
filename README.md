# Waffle32

The deployment can be found [here](https://wafflesj.github.io/Waffle32/).
## About
This is a web compiler designed exclusively for browser compiling and flashing for ESP32 microcontroller boards.
## Compilation
The compiler is the Arduino CLI run though GitHub actions. When the button the webpage is pressed for compilation a Cloudflare worker runs the action,
this worker is used to protect the GitHub action tokens from the open internet and being placed directly in the source.
## Libraries
As per the Arduino CLI libraries lists must be given additionally outside of the `#include` within the code. On the left side panel libraries are added by name before they can be used 
inside the program. It should be noted that `#include` is still needed inside the main program as standard with C++.
## Files
Below the library section on the side panel is a list of files in the program. Accepted file types are `.ino`, `.cpp`, `.c`, `.h` or `.hpp`. Note: `.ino` is equavalent to `.cpp`. These 
files behave as expected, they must be included with `#include` and are compiled alongside the main code file.
## Flashing
To upload compiled code to a connected ESP32 device use the connect button and select the port with the ESP32. Your device will need a driver compatible, some system such as windows do not come
with this. A common driver is the SiliconLabs `CP210x`. Once connected the serial monitor immediately becomes available. Additionally, after connected the Flash button transfers the binary to the 
device.
## Editor
The code editor within the page is compressed version of MirrorCode with customized syntax highlight colours. Due to the nature of the editor requests to add features will be denied.
