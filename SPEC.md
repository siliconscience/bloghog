Vision: a simple blogger site

goals: allow a user to
* have an authenticaed user login experience
* passwords can be saved with a scheme like /etc/passwd, not plaintext
* each user can create multiple blogs and each blogs can contain multiple posts
* a post contains images and text
* the things a user can do are
* create a blog (a collection of posts)
* create a blog entry (a post)
* in the post, allow the addition of
** a block of text
** an image
** a table with up to three columns
** read a group of images and create a thumbnail view
*** thumbnails are sized to fit 3 side by side on a cellphone screen
*** later will add a method to reorder
**** maybe a manual bubble sort
**** maybe a drag and drop

steps:
* create a basic blog creation tool - user can give it a name and a purpose
* create a basic post creation tool - user can create a post
* allow user to enter text block on post
* allow user to add an image to post
* pause there for now
* calendar: A blog has a calendar display button (or this is the front page of that blog)
* the calendar is an eight week view starting in the current week
* each row of the calendar is a week starting on monday and ending sunday
* the number of weeks can be reduced to 4 or increased to 8
* the start date can be changed with a dropdown
* every blog entry needs a date and is shown on the calendar
* the date is stored in the meta for that blog under "hikeDate"
* if there is more than one on a date, they can be listed as 28a 28b 28c if they are on say sep 28


tech stack:
* node.js backend
* text and images stored as is, without a database
