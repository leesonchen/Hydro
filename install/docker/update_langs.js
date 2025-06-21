// MongoDB script to update system domain languages
db = db.getSiblingDB('hydro');
result = db.domain.updateOne(
  {_id: 'system'}, 
  {$set: {langs: 'cc,cc.cc14,cc.cc17,cc.cc20,py,py.py3,java,js,go,rs,pas,php'}}
);
print('Update result:', JSON.stringify(result));

// Verify the update
domain = db.domain.findOne({_id: 'system'});
print('Updated domain langs:', domain.langs); 